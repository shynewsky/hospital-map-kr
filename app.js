(() => {
  "use strict";

  const TYPE_GROUPS = [
    { id: "tertiary", label: "상급종합", types: ["상급종합"] },
    { id: "general", label: "종합병원", types: ["종합병원"] },
    { id: "hospital", label: "병원", types: ["병원"] },
    { id: "clinic", label: "의원", types: ["의원"] },
    { id: "mental", label: "정신병원", types: ["정신병원"] },
    { id: "care", label: "요양병원", types: ["요양병원"] },
    { id: "public", label: "보건기관", types: ["보건의료원", "보건소", "보건지소", "보건진료소"] },
  ];

  const EQUIPMENT_LABELS = { xray: "X-ray", ct: "CT", mri: "MRI" };
  const MAX_LIST_RESULTS = 80;
  const MAX_MAP_MARKERS = 1000;
  const SEOUL_CODE = "110000";

  const dom = {
    mapStatus: document.querySelector("#map-status"),
    locationButton: document.querySelector("#location-button"),
    searchInput: document.querySelector("#search-input"),
    searchButton: document.querySelector("#search-button"),
    regionSelect: document.querySelector("#region-select"),
    sourceDate: document.querySelector("#source-date"),
    typeFilters: document.querySelector("#type-filters"),
    departmentSelect: document.querySelector("#department-select"),
    specialistOnly: document.querySelector("#specialist-only"),
    equipmentFilters: document.querySelector("#equipment-filters"),
    resetFilters: document.querySelector("#reset-filters"),
    resultCount: document.querySelector("#result-count"),
    resultContext: document.querySelector("#result-context"),
    results: document.querySelector("#results"),
    listFooter: document.querySelector("#list-footer"),
    statusBanner: document.querySelector("#status-banner"),
    sortTabs: document.querySelector(".sort-tabs"),
    infoDialog: document.querySelector("#info-dialog"),
    openInfo: document.querySelector("#open-info"),
  };

  const state = {
    manifest: null,
    departments: [],
    hospitals: [],
    filtered: [],
    currentRegionCode: "",
    selectedTypeGroups: new Set(TYPE_GROUPS.map((group) => group.id)),
    selectedDepartment: "",
    selectedEquipment: new Set(),
    specialistOnly: false,
    query: "",
    sort: "distance",
    userLocation: null,
    distanceOrigin: { lat: 37.5665, lng: 126.978, label: "지도 중심" },
    userMarker: null,
    expanded: new Set(),
    pinnedHospitalId: null,
    markerById: new Map(),
    loading: false,
    renderTimer: null,
  };

  const map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    minZoom: 6,
    maxZoom: 19,
  }).setView([36.3, 127.8], 7);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const markerLayer = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 44,
    spiderfyOnMaxZoom: true,
    removeOutsideVisibleBounds: true,
  }).addTo(map);

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeSearch(value) {
    return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
  }

  function haversineKm(first, second) {
    if (!first || !second) return Number.POSITIVE_INFINITY;
    const toRadians = (degrees) => (degrees * Math.PI) / 180;
    const earthRadiusKm = 6371.0088;
    const deltaLat = toRadians(second.lat - first.lat);
    const deltaLng = toRadians(second.lng - first.lng);
    const lat1 = toRadians(first.lat);
    const lat2 = toRadians(second.lat);
    const a =
      Math.sin(deltaLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDistance(distanceKm) {
    if (!Number.isFinite(distanceKm)) return "거리 미확인";
    if (distanceKm < 1) return `${Math.max(10, Math.round((distanceKm * 1000) / 10) * 10)}m`;
    if (distanceKm < 10) return `${distanceKm.toFixed(1)}km`;
    return `${Math.round(distanceKm)}km`;
  }

  function typeClass(type) {
    if (["상급종합", "종합병원"].includes(type)) return "tertiary";
    if (["병원", "정신병원", "요양병원"].includes(type)) return "hospital";
    return "clinic";
  }

  function selectedOfficialTypes() {
    return new Set(
      TYPE_GROUPS.filter((group) => state.selectedTypeGroups.has(group.id)).flatMap((group) => group.types)
    );
  }

  function websiteUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      const url = new URL(candidate);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function renderTypeFilters() {
    dom.typeFilters.innerHTML = TYPE_GROUPS.map(
      (group) => `
        <label>
          <input type="checkbox" value="${group.id}" ${state.selectedTypeGroups.has(group.id) ? "checked" : ""}>
          <span>${group.label}</span>
        </label>`
    ).join("");
  }

  function renderDepartmentOptions() {
    const options = state.departments
      .map((department) => `<option value="${escapeHtml(department.code)}">${escapeHtml(department.name)}</option>`)
      .join("");
    dom.departmentSelect.innerHTML = `<option value="">전체 진료과목</option>${options}`;
  }

  function renderRegionOptions() {
    dom.regionSelect.innerHTML = state.manifest.regions
      .map((region) => `<option value="${region.code}">${escapeHtml(region.name)} (${region.count.toLocaleString("ko-KR")}곳)</option>`)
      .join("");
  }

  function regionByCode(code) {
    return state.manifest?.regions.find((region) => region.code === code) || null;
  }

  function findRegionForLocation(location) {
    const containing = state.manifest.regions.find((region) => {
      const bounds = region.bounds;
      return (
        location.lat >= bounds.south &&
        location.lat <= bounds.north &&
        location.lng >= bounds.west &&
        location.lng <= bounds.east
      );
    });
    if (containing) return containing;

    return [...state.manifest.regions]
      .map((region) => ({
        region,
        distance: haversineKm(location, {
          lat: (region.bounds.south + region.bounds.north) / 2,
          lng: (region.bounds.west + region.bounds.east) / 2,
        }),
      }))
      .sort((a, b) => a.distance - b.distance)[0]?.region;
  }

  function showBanner(message, kind = "notice") {
    dom.statusBanner.hidden = !message;
    dom.statusBanner.textContent = message || "";
    dom.statusBanner.dataset.kind = kind;
  }

  function setLoading(loading, message = "데이터를 불러오는 중입니다.") {
    state.loading = loading;
    dom.regionSelect.disabled = loading;
    dom.mapStatus.textContent = loading ? message : dom.mapStatus.textContent;
  }

  async function loadRegion(code, { fit = true, reason = "지역 선택" } = {}) {
    if (!code || state.loading) return;
    const region = regionByCode(code);
    if (!region) return;
    setLoading(true, `${region.name} 병원 데이터를 불러오는 중입니다.`);
    showBanner("");
    try {
      const response = await fetch(region.url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      state.hospitals = payload.hospitals || [];
      state.currentRegionCode = code;
      dom.regionSelect.value = code;
      dom.sourceDate.textContent = `병원 ${payload.sourceReferenceDate.slice(0, 7)} · 장비 ${payload.equipmentReferenceDate.slice(0, 7)}`;
      state.expanded.clear();
      state.pinnedHospitalId = null;

      if (fit) {
        map.fitBounds(
          [
            [region.bounds.south, region.bounds.west],
            [region.bounds.north, region.bounds.east],
          ],
          { padding: [24, 24], maxZoom: 12 }
        );
      }
      if (!state.userLocation) {
        const center = map.getCenter();
        state.distanceOrigin = { lat: center.lat, lng: center.lng, label: "지도 중심" };
      }
      applyFilters();
      dom.mapStatus.textContent = `${region.name} ${state.hospitals.length.toLocaleString("ko-KR")}곳을 불러왔습니다.`;
      if (reason === "fallback") {
        showBanner("현재 위치를 사용할 수 없어 서울을 기본 지역으로 표시합니다. 지역 선택에서 바꿀 수 있습니다.");
      }
    } catch (error) {
      console.error(error);
      dom.mapStatus.textContent = "데이터를 불러오지 못했습니다.";
      showBanner("병원 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
      renderEmpty("데이터를 불러오지 못했습니다", "네트워크 연결을 확인하고 지역을 다시 선택해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  function departmentFor(hospital, code) {
    if (!code) return null;
    return hospital.departments.find((department) => department.code === code) || null;
  }

  function applyFilters() {
    if (!state.hospitals.length) {
      state.filtered = [];
      renderAll();
      return;
    }

    const officialTypes = selectedOfficialTypes();
    const query = normalizeSearch(state.query);
    const origin = state.userLocation || state.distanceOrigin;
    const selectedDepartment = state.selectedDepartment;
    const selectedEquipment = [...state.selectedEquipment];

    state.filtered = state.hospitals
      .filter((hospital) => !officialTypes.size || officialTypes.has(hospital.type))
      .filter((hospital) => {
        if (!query) return true;
        return normalizeSearch(`${hospital.name} ${hospital.address} ${hospital.district}`).includes(query);
      })
      .filter((hospital) => {
        if (!selectedDepartment) return true;
        const department = departmentFor(hospital, selectedDepartment);
        if (!department) return false;
        return !state.specialistOnly || department.specialists > 0;
      })
      .filter((hospital) => selectedEquipment.every((key) => hospital.equipment[key] > 0))
      .map((hospital) => ({
        ...hospital,
        distanceKm: haversineKm(origin, hospital),
      }));

    state.filtered.sort((first, second) => {
      if (state.sort === "name") return first.name.localeCompare(second.name, "ko-KR");
      return first.distanceKm - second.distanceKm || first.name.localeCompare(second.name, "ko-KR");
    });

    renderAll();
  }

  function renderAll() {
    renderResultHeader();
    renderList();
    renderMarkers();
  }

  function renderResultHeader() {
    const count = state.filtered.length;
    dom.resultCount.textContent = `${count.toLocaleString("ko-KR")}곳`;
    dom.resultContext.textContent = state.userLocation ? "을 현재 위치 기준으로 찾았습니다" : "을 지도 중심 기준으로 찾았습니다";
  }

  function specialistTags(hospital) {
    if (state.selectedDepartment) {
      const department = departmentFor(hospital, state.selectedDepartment);
      if (!department) return "";
      return `<span class="tag specialist">${escapeHtml(department.name)} 전문의 ${department.specialists}명</span>`;
    }

    const specialists = hospital.departments.filter((department) => department.specialists > 0).slice(0, 3);
    if (!specialists.length) {
      return `<span class="tag neutral">전문의 보유 신고 없음</span>`;
    }
    return specialists
      .map(
        (department) =>
          `<span class="tag specialist">${escapeHtml(department.name)} ${department.specialists}명</span>`
      )
      .join("");
  }

  function equipmentTags(hospital) {
    const tags = Object.entries(EQUIPMENT_LABELS)
      .filter(([key]) => hospital.equipment[key] > 0)
      .map(
        ([key, label]) =>
          `<span class="tag equipment">${label} ${hospital.equipment[key]}대 보유 신고</span>`
      );
    return tags.length ? tags.join("") : `<span class="tag neutral">선택 장비 보유 신고 없음</span>`;
  }

  function departmentDetail(hospital) {
    const departments = hospital.departments.slice(0, 14);
    if (!departments.length) {
      return `<p class="detail-note">공개된 진료과목 데이터가 없습니다.</p>`;
    }
    const items = departments
      .map(
        (department) => `
          <li>
            <span>${escapeHtml(department.name)} <small>등록</small></span>
            <b>전문의 ${department.specialists}명</b>
          </li>`
      )
      .join("");
    const more = hospital.departments.length > departments.length
      ? `<p class="detail-note">외 ${hospital.departments.length - departments.length}개 진료과목이 등록되어 있습니다.</p>`
      : "";
    return `<ul class="department-list">${items}</ul>${more}`;
  }

  function renderHospitalCard(hospital) {
    const expanded = state.expanded.has(hospital.id);
    const specialistCount = hospital.departments.filter((department) => department.specialists > 0).length;
    const website = websiteUrl(hospital.website);
    const phoneHref = hospital.phone ? `tel:${hospital.phone.replace(/[^0-9+]/g, "")}` : "";
    const navigationUrl = `https://map.naver.com/p/search/${encodeURIComponent(`${hospital.name} ${hospital.address}`)}`;
    const designationTags = hospital.designations
      .map((designation) => `<span class="tag designation">전문병원 지정: ${escapeHtml(designation)}</span>`)
      .join("");

    return `
      <article class="hospital-card ${state.pinnedHospitalId === hospital.id ? "highlighted" : ""}" id="hospital-${hospital.id}" data-id="${hospital.id}">
        <div class="card-main">
          <div class="card-kicker">
            <span class="type-badge ${typeClass(hospital.type)}">${escapeHtml(hospital.type)}</span>
            <span class="distance-badge">${formatDistance(hospital.distanceKm)}</span>
          </div>
          <div class="card-title-row">
            <h3 class="card-title">${escapeHtml(hospital.name)}</h3>
            <button class="expand-button" type="button" data-action="expand" data-id="${hospital.id}" aria-expanded="${expanded}" aria-label="${expanded ? "상세 접기" : "상세 펼치기"}">${expanded ? "∧" : "∨"}</button>
          </div>
          <p class="card-address">${escapeHtml(hospital.address)}</p>
          <div class="tag-row">
            <span class="tag neutral">의사 ${hospital.doctorTotal}명</span>
            <span class="tag neutral">진료과목 ${hospital.departments.length}개 등록</span>
            <span class="tag neutral">전문의 과목 ${specialistCount}개</span>
          </div>
          <div class="tag-row">${specialistTags(hospital)}</div>
          <div class="tag-row">${equipmentTags(hospital)}${designationTags}</div>
        </div>
        ${expanded ? `
          <div class="card-detail">
            <div class="detail-section">
              <h4>진료과목 등록과 전문의 신고 수</h4>
              ${departmentDetail(hospital)}
              <p class="detail-note">진료과목 등록은 현재 진료 가능 여부를 뜻하지 않습니다. 전문의 0명은 해당 과목 전문의 수가 0명으로 공개된 경우입니다.</p>
            </div>
            <div class="detail-section">
              <h4>장비 보유 신고</h4>
              <div class="tag-row">${equipmentTags(hospital)}</div>
              <p class="detail-note">장비 데이터 기준일은 2024-12-31입니다. 실제 검사 가능 여부와 예약 상황은 의료기관에 전화로 확인하세요.</p>
            </div>
            <div class="card-actions">
              <a class="${phoneHref ? "primary-action" : "disabled"}" href="${phoneHref || "#"}">${hospital.phone ? `전화 ${escapeHtml(hospital.phone)}` : "전화번호 없음"}</a>
              <a href="${navigationUrl}" target="_blank" rel="noopener noreferrer">네이버 길찾기</a>
              ${website ? `<a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer">홈페이지</a>` : `<button type="button" data-action="copy-address" data-address="${escapeHtml(hospital.address)}">주소 복사</button>`}
            </div>
          </div>` : ""}
      </article>`;
  }

  function renderList() {
    if (state.loading) {
      renderEmpty("병원 데이터를 불러오는 중입니다", "잠시만 기다려 주세요.");
      return;
    }
    if (!state.currentRegionCode) {
      renderEmpty("현재 위치를 확인하고 있습니다", "위치 권한을 허용하거나 지역을 직접 선택해 주세요.");
      return;
    }
    if (!state.filtered.length) {
      renderEmpty("조건에 맞는 병원이 없습니다", "필터를 하나씩 해제하거나 다른 지역을 선택해 보세요. 필터는 자동으로 완화하지 않습니다.");
      dom.listFooter.textContent = "";
      return;
    }

    let visible = state.filtered.slice(0, MAX_LIST_RESULTS);
    if (state.pinnedHospitalId && !visible.some((hospital) => hospital.id === state.pinnedHospitalId)) {
      const pinned = state.filtered.find((hospital) => hospital.id === state.pinnedHospitalId);
      if (pinned) visible = [pinned, ...visible.slice(0, MAX_LIST_RESULTS - 1)];
    }

    dom.results.innerHTML = visible.map(renderHospitalCard).join("");
    dom.listFooter.textContent = state.filtered.length > MAX_LIST_RESULTS
      ? `목록은 가까운 ${MAX_LIST_RESULTS}곳까지 표시합니다. 지도를 움직이거나 필터를 추가하면 결과가 바뀝니다.`
      : "방문 전 전화로 진료 가능 여부와 장비 운영 여부를 확인하세요.";
  }

  function renderEmpty(title, description) {
    dom.results.innerHTML = `<div class="empty-state"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>`;
  }

  function markerIcon(hospital) {
    return L.divIcon({
      className: `hospital-marker ${typeClass(hospital.type)}`,
      html: "<span></span>",
      iconSize: [24, 24],
      iconAnchor: [12, 24],
      popupAnchor: [0, -24],
    });
  }

  function renderMarkers() {
    markerLayer.clearLayers();
    state.markerById.clear();
    if (!state.filtered.length) {
      dom.mapStatus.textContent = state.currentRegionCode ? "필터 조건에 맞는 지도 결과가 없습니다." : "지역을 선택해 주세요.";
      return;
    }

    const bounds = map.getBounds().pad(0.25);
    let candidates = state.filtered.filter((hospital) => bounds.contains([hospital.lat, hospital.lng]));
    if (!candidates.length) candidates = state.filtered;
    candidates = candidates
      .map((hospital) => ({ hospital, centerDistance: map.distance(map.getCenter(), [hospital.lat, hospital.lng]) }))
      .sort((first, second) => first.centerDistance - second.centerDistance)
      .slice(0, MAX_MAP_MARKERS)
      .map((entry) => entry.hospital);

    const markers = candidates.map((hospital) => {
      const marker = L.marker([hospital.lat, hospital.lng], { icon: markerIcon(hospital), title: hospital.name });
      marker.bindTooltip(`<b>${escapeHtml(hospital.name)}</b><br>${escapeHtml(hospital.type)} · ${formatDistance(hospital.distanceKm)}`, {
        direction: "top",
        offset: [0, -20],
      });
      marker.on("click", () => focusHospital(hospital.id, false));
      state.markerById.set(hospital.id, marker);
      return marker;
    });
    markerLayer.addLayers(markers);

    const region = regionByCode(state.currentRegionCode);
    const suffix = state.filtered.length > candidates.length ? ` · 지도에는 중심 주변 ${candidates.length.toLocaleString("ko-KR")}곳 표시` : "";
    dom.mapStatus.textContent = `${region?.name || "선택 지역"} ${state.filtered.length.toLocaleString("ko-KR")}곳${suffix}`;
  }

  function focusHospital(id, moveMap = true) {
    const hospital = state.filtered.find((item) => item.id === id);
    if (!hospital) return;
    state.pinnedHospitalId = id;
    state.expanded.add(id);
    renderList();
    if (moveMap) map.setView([hospital.lat, hospital.lng], Math.max(map.getZoom(), 15));
    window.setTimeout(() => {
      document.querySelector(`#hospital-${CSS.escape(id)}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 40);
  }

  function setUserLocation(location) {
    state.userLocation = location;
    state.distanceOrigin = { ...location, label: "현재 위치" };
    if (state.userMarker) map.removeLayer(state.userMarker);
    state.userMarker = L.marker([location.lat, location.lng], {
      icon: L.divIcon({ className: "user-location-marker", iconSize: [19, 19], iconAnchor: [9, 9] }),
      zIndexOffset: 2000,
      title: "현재 위치",
    }).addTo(map);
    state.userMarker.bindTooltip("현재 위치", { permanent: false, direction: "top" });
  }

  function requestLocation({ automatic = false } = {}) {
    if (!navigator.geolocation) {
      showBanner("이 브라우저에서는 현재 위치를 사용할 수 없습니다. 지역을 직접 선택해 주세요.");
      if (!state.currentRegionCode) loadRegion(SEOUL_CODE, { reason: "fallback" });
      return;
    }

    dom.locationButton.disabled = true;
    dom.mapStatus.textContent = "현재 위치를 확인하고 있습니다.";
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const location = { lat: position.coords.latitude, lng: position.coords.longitude };
        setUserLocation(location);
        const region = findRegionForLocation(location);
        map.setView([location.lat, location.lng], 14);
        if (region) await loadRegion(region.code, { fit: false, reason: "location" });
        else if (!state.currentRegionCode) await loadRegion(SEOUL_CODE, { fit: false, reason: "fallback" });
        applyFilters();
        showBanner("");
        dom.locationButton.disabled = false;
      },
      async (error) => {
        console.warn("Location unavailable", error.code);
        dom.locationButton.disabled = false;
        if (!automatic || !state.currentRegionCode) {
          showBanner("위치 권한이 없거나 현재 위치를 확인하지 못했습니다. 선택한 지역과 지도 중심을 기준으로 거리를 계산합니다.");
        }
        if (!state.currentRegionCode) await loadRegion(SEOUL_CODE, { reason: "fallback" });
      },
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 300000 }
    );
  }

  async function copyAddress(address) {
    try {
      await navigator.clipboard.writeText(address);
      showBanner("주소를 복사했습니다.");
      window.setTimeout(() => showBanner(""), 1800);
    } catch {
      showBanner("주소를 복사하지 못했습니다. 주소를 길게 눌러 복사해 주세요.");
    }
  }

  function bindEvents() {
    dom.locationButton.addEventListener("click", () => requestLocation());
    dom.searchButton.addEventListener("click", () => {
      state.query = dom.searchInput.value.trim();
      applyFilters();
    });
    dom.searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        state.query = dom.searchInput.value.trim();
        applyFilters();
      }
    });
    dom.searchInput.addEventListener("search", () => {
      state.query = dom.searchInput.value.trim();
      applyFilters();
    });
    dom.regionSelect.addEventListener("change", () => loadRegion(dom.regionSelect.value));
    dom.typeFilters.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      if (event.target.checked) state.selectedTypeGroups.add(event.target.value);
      else state.selectedTypeGroups.delete(event.target.value);
      applyFilters();
    });
    dom.departmentSelect.addEventListener("change", () => {
      state.selectedDepartment = dom.departmentSelect.value;
      dom.specialistOnly.disabled = !state.selectedDepartment;
      if (!state.selectedDepartment) {
        state.specialistOnly = false;
        dom.specialistOnly.checked = false;
      }
      applyFilters();
    });
    dom.specialistOnly.addEventListener("change", () => {
      state.specialistOnly = dom.specialistOnly.checked;
      applyFilters();
    });
    dom.equipmentFilters.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      if (event.target.checked) state.selectedEquipment.add(event.target.value);
      else state.selectedEquipment.delete(event.target.value);
      applyFilters();
    });
    dom.resetFilters.addEventListener("click", () => {
      state.selectedTypeGroups = new Set(TYPE_GROUPS.map((group) => group.id));
      state.selectedDepartment = "";
      state.selectedEquipment.clear();
      state.specialistOnly = false;
      state.query = "";
      dom.searchInput.value = "";
      dom.departmentSelect.value = "";
      dom.specialistOnly.checked = false;
      dom.specialistOnly.disabled = true;
      dom.equipmentFilters.querySelectorAll("input").forEach((input) => { input.checked = false; });
      renderTypeFilters();
      applyFilters();
    });
    dom.sortTabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-sort]");
      if (!button) return;
      state.sort = button.dataset.sort;
      dom.sortTabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
      applyFilters();
    });
    dom.results.addEventListener("click", (event) => {
      const expandButton = event.target.closest("[data-action='expand']");
      if (expandButton) {
        const id = expandButton.dataset.id;
        if (state.expanded.has(id)) state.expanded.delete(id);
        else state.expanded.add(id);
        state.pinnedHospitalId = id;
        renderList();
        return;
      }
      const copyButton = event.target.closest("[data-action='copy-address']");
      if (copyButton) copyAddress(copyButton.dataset.address || "");
    });
    dom.openInfo.addEventListener("click", () => dom.infoDialog.showModal());
    dom.infoDialog.addEventListener("click", (event) => {
      if (event.target === dom.infoDialog) dom.infoDialog.close();
    });
    map.on("moveend", () => {
      if (!state.userLocation) {
        const center = map.getCenter();
        state.distanceOrigin = { lat: center.lat, lng: center.lng, label: "지도 중심" };
      }
      window.clearTimeout(state.renderTimer);
      state.renderTimer = window.setTimeout(applyFilters, 120);
    });
  }

  async function initialize() {
    renderTypeFilters();
    bindEvents();
    renderEmpty("공식 병원 데이터를 준비하고 있습니다", "현재 위치 권한을 허용하면 주변 병원을 먼저 보여드립니다.");

    try {
      const [manifestResponse, departmentsResponse] = await Promise.all([
        fetch("data/manifest.json"),
        fetch("data/departments.json"),
      ]);
      if (!manifestResponse.ok || !departmentsResponse.ok) throw new Error("Static data unavailable");
      state.manifest = await manifestResponse.json();
      const departmentPayload = await departmentsResponse.json();
      state.departments = departmentPayload.departments || [];
      renderRegionOptions();
      renderDepartmentOptions();
      dom.mapStatus.textContent = `전국 ${state.manifest.totalHospitals.toLocaleString("ko-KR")}곳 중 현재 지역을 표시합니다.`;
      requestLocation({ automatic: true });
    } catch (error) {
      console.error(error);
      showBanner("정적 데이터를 불러오지 못했습니다. 페이지를 새로고침해 주세요.", "error");
      renderEmpty("데이터를 불러오지 못했습니다", "페이지 새로고침 후에도 문제가 계속되면 GitHub 저장소의 이슈로 알려주세요.");
      dom.mapStatus.textContent = "데이터 연결 오류";
    }
  }

  initialize();
})();
