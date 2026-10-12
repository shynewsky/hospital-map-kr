(() => {
  "use strict";

  const SEOUL_CODE = "110000";
  const MAX_LIST_RESULTS = 80;
  const MAX_MAP_MARKERS = 1000;
  const TYPE_LABELS = [
    "상급종합", "종합병원", "병원", "정신병원", "요양병원", "의원",
    "보건의료원", "보건소", "보건지소", "보건진료소",
  ];
  const TYPE_GROUPS = {
    "상급종합": "tertiary", "종합병원": "tertiary",
    "병원": "hospital", "정신병원": "hospital", "요양병원": "hospital",
    "의원": "clinic", "보건의료원": "clinic", "보건소": "clinic",
    "보건지소": "clinic", "보건진료소": "clinic",
  };
  const KOREA_BOUNDS = L.latLngBounds([32.7, 123.0], [39.7, 133.2]);

  const state = {
    manifest: null,
    departments: [],
    equipmentCatalog: [],
    equipmentByCode: new Map(),
    regionCache: new Map(),
    hospitals: [],
    filtered: [],
    selectedRegions: new Set(),
    selectedTypes: new Set(TYPE_LABELS),
    selectedDepartments: new Set(),
    selectedSpecialists: new Set(),
    selectedEquipment: new Set(),
    query: "",
    sort: "distance",
    userLocation: null,
    mapCenter: { lat: 36.3, lng: 127.8 },
    userMarker: null,
    loading: false,
    loadToken: 0,
    initialRegionCode: SEOUL_CODE,
    renderTimer: null,
  };

  const dom = {
    mapStatus: document.querySelector("#map-status"),
    locationButton: document.querySelector("#location-button"),
    searchInput: document.querySelector("#search-input"),
    searchButton: document.querySelector("#search-button"),
    filterToggle: document.querySelector("#filter-toggle"),
    filterPanel: document.querySelector("#filter-panel"),
    activeFilterCount: document.querySelector("#active-filter-count"),
    resetFilters: document.querySelector("#reset-filters"),
    sourceDate: document.querySelector("#source-date"),
    regionFilters: document.querySelector("#region-filters"),
    typeFilters: document.querySelector("#type-filters"),
    departmentFilters: document.querySelector("#department-filters"),
    specialistFilters: document.querySelector("#specialist-filters"),
    equipmentFilters: document.querySelector("#equipment-filters"),
    regionSummary: document.querySelector("#region-summary"),
    typeSummary: document.querySelector("#type-summary"),
    departmentSummary: document.querySelector("#department-summary"),
    specialistSummary: document.querySelector("#specialist-summary"),
    equipmentSummary: document.querySelector("#equipment-summary"),
    resultCount: document.querySelector("#result-count"),
    resultContext: document.querySelector("#result-context"),
    sortTabs: document.querySelector(".sort-tabs"),
    statusBanner: document.querySelector("#status-banner"),
    results: document.querySelector("#results"),
    listFooter: document.querySelector("#list-footer"),
    openInfo: document.querySelector("#open-info"),
    infoDialog: document.querySelector("#info-dialog"),
    detailDialog: document.querySelector("#detail-dialog"),
    detailDialogContent: document.querySelector("#detail-dialog-content"),
  };

  const map = L.map("map", {
    zoomControl: true,
    minZoom: 6,
    maxZoom: 19,
    maxBounds: KOREA_BOUNDS.pad(0.2),
  }).setView([36.3, 127.8], 7);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  const markerLayer = L.markerClusterGroup({
    chunkedLoading: true,
    maxClusterRadius: 52,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    removeOutsideVisibleBounds: true,
  }).addTo(map);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    }[character]));
  }

  function normalizeSearch(value) {
    return String(value || "").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ").trim();
  }

  function websiteUrl(value) {
    const url = String(value || "").trim();
    if (!url) return "";
    if (/^https?:\/\//i.test(url)) return url;
    return `https://${url}`;
  }

  function haversineKm(origin, hospital) {
    if (!origin) return Number.POSITIVE_INFINITY;
    const toRadians = (degree) => degree * Math.PI / 180;
    const latitudeDelta = toRadians(hospital.lat - origin.lat);
    const longitudeDelta = toRadians(hospital.lng - origin.lng);
    const firstLatitude = toRadians(origin.lat);
    const secondLatitude = toRadians(hospital.lat);
    const a = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function formatDistance(distanceKm) {
    if (!Number.isFinite(distanceKm)) return "거리 미확인";
    if (distanceKm < 1) return `${Math.max(10, Math.round(distanceKm * 1000 / 10) * 10)}m`;
    if (distanceKm < 10) return `${distanceKm.toFixed(1)}km`;
    return `${Math.round(distanceKm)}km`;
  }

  function typeClass(type) {
    return TYPE_GROUPS[type] || "clinic";
  }

  function regionByCode(code) {
    return state.manifest?.regions.find((region) => region.code === code);
  }

  function departmentFor(hospital, code) {
    return hospital.departments.find((department) => department.code === code);
  }

  function equipmentLabel(code) {
    return state.equipmentByCode.get(code)?.name || code;
  }

  function showBanner(message) {
    dom.statusBanner.hidden = !message;
    dom.statusBanner.textContent = message;
  }

  function renderEmpty(title, description) {
    dom.results.innerHTML = `<div class="empty-state"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(description)}</p></div>`;
  }

  function setLoading(loading, message = "") {
    state.loading = loading;
    if (message) dom.mapStatus.textContent = message;
  }

  function checkboxMarkup(value, label, checked, detail = "") {
    return `<label><input type="checkbox" value="${escapeHtml(value)}" ${checked ? "checked" : ""}><span class="option-copy"><span>${escapeHtml(label)}</span>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span></label>`;
  }

  function renderRegionFilters() {
    if (!state.manifest) return;
    dom.regionFilters.innerHTML = state.manifest.regions.map((region) => checkboxMarkup(
      region.code,
      region.name,
      state.selectedRegions.has(region.code),
      `${region.count.toLocaleString("ko-KR")}곳`,
    )).join("");
  }

  function renderTypeFilters() {
    dom.typeFilters.innerHTML = TYPE_LABELS.map((type) => checkboxMarkup(
      type,
      type,
      state.selectedTypes.has(type),
    )).join("");
  }

  function renderDepartmentFilters() {
    dom.departmentFilters.innerHTML = state.departments.map((department) => checkboxMarkup(
      department.code,
      department.name,
      state.selectedDepartments.has(department.code),
    )).join("");
  }

  function renderSpecialistFilters() {
    const general = checkboxMarkup(
      "general",
      "일반의",
      state.selectedSpecialists.has("general"),
      "전문의가 없는 등록기관 포함",
    );
    const specialists = state.departments.map((department) => checkboxMarkup(
      department.code,
      department.name,
      state.selectedSpecialists.has(department.code),
      "전문의 1명 이상",
    )).join("");
    dom.specialistFilters.innerHTML = general + specialists;
  }

  function renderEquipmentFilters() {
    const groups = new Map();
    state.equipmentCatalog.forEach((item) => {
      if (!groups.has(item.group)) groups.set(item.group, []);
      groups.get(item.group).push(item);
    });
    dom.equipmentFilters.innerHTML = [...groups.entries()].map(([group, items]) => `
      <div class="checklist-group-title">${escapeHtml(group)}</div>
      ${items.map((item) => checkboxMarkup(
        item.code,
        item.name,
        state.selectedEquipment.has(item.code),
        `${item.hospitalCount.toLocaleString("ko-KR")}곳 · ${item.quantity.toLocaleString("ko-KR")}대`,
      )).join("")}
    `).join("");
  }

  function selectedNames(selected, catalog, fallback = "전체") {
    if (!selected.size) return fallback;
    const names = [...selected].map((code) => catalog.get(code) || code);
    if (names.length <= 2) return names.join(", ");
    return `${names[0]} 외 ${names.length - 1}개`;
  }

  function updateFilterSummaries() {
    const regionNames = new Map((state.manifest?.regions || []).map((region) => [region.code, region.name]));
    const departmentNames = new Map(state.departments.map((department) => [department.code, department.name]));
    const specialistNames = new Map([["general", "일반의"], ...state.departments.map((department) => [department.code, department.name])]);
    const equipmentNames = new Map(state.equipmentCatalog.map((item) => [item.code, item.name]));

    dom.regionSummary.textContent = selectedNames(state.selectedRegions, regionNames, "선택 필요");
    dom.typeSummary.textContent = state.selectedTypes.size === TYPE_LABELS.length
      ? "전체"
      : selectedNames(state.selectedTypes, new Map(TYPE_LABELS.map((type) => [type, type])), "선택 없음");
    dom.departmentSummary.textContent = selectedNames(state.selectedDepartments, departmentNames);
    dom.specialistSummary.textContent = selectedNames(state.selectedSpecialists, specialistNames);
    dom.equipmentSummary.textContent = selectedNames(state.selectedEquipment, equipmentNames);

    const activeCount = state.selectedRegions.size
      + (state.selectedTypes.size === TYPE_LABELS.length ? 0 : state.selectedTypes.size)
      + state.selectedDepartments.size
      + state.selectedSpecialists.size
      + state.selectedEquipment.size;
    dom.activeFilterCount.hidden = activeCount === 0;
    dom.activeFilterCount.textContent = String(activeCount);
  }

  function combinedBounds(codes) {
    const bounds = L.latLngBounds([]);
    codes.forEach((code) => {
      const region = regionByCode(code);
      if (!region?.bounds) return;
      bounds.extend([region.bounds.south, region.bounds.west]);
      bounds.extend([region.bounds.north, region.bounds.east]);
    });
    return bounds.isValid() ? bounds : null;
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
  }

  async function loadSelectedRegions({ fit = true } = {}) {
    const codes = [...state.selectedRegions];
    const token = ++state.loadToken;
    updateFilterSummaries();

    if (!codes.length) {
      state.hospitals = [];
      setLoading(false);
      applyFilters();
      dom.mapStatus.textContent = "지역을 한 곳 이상 선택해 주세요.";
      dom.sourceDate.textContent = "";
      return;
    }

    setLoading(true, `${codes.length}개 지역 데이터를 불러오는 중입니다.`);
    renderEmpty("병원 데이터를 불러오는 중입니다", "선택한 지역의 공식 데이터를 준비하고 있습니다.");

    try {
      const payloads = await Promise.all(codes.map(async (code) => {
        if (state.regionCache.has(code)) return state.regionCache.get(code);
        const region = regionByCode(code);
        if (!region) throw new Error(`Unknown region: ${code}`);
        const payload = await fetchJson(region.url);
        state.regionCache.set(code, payload);
        return payload;
      }));
      if (token !== state.loadToken) return;

      const byId = new Map();
      payloads.forEach((payload) => {
        (payload.hospitals || []).forEach((hospital) => byId.set(hospital.id, hospital));
      });
      state.hospitals = [...byId.values()];
      const referenceDate = payloads[0]?.sourceReferenceDate || "";
      dom.sourceDate.textContent = referenceDate ? `병원 ${referenceDate}` : "";
      setLoading(false);

      if (fit) {
        const bounds = combinedBounds(codes);
        if (bounds) map.fitBounds(bounds, { padding: [28, 28], maxZoom: codes.length === 1 ? 10 : 8 });
      }
      applyFilters();
      showBanner("");
    } catch (error) {
      if (token !== state.loadToken) return;
      console.error(error);
      setLoading(false);
      state.hospitals = [];
      showBanner("선택한 지역 데이터를 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
      renderEmpty("데이터를 불러오지 못했습니다", "네트워크 연결을 확인하고 다시 시도해 주세요.");
    }
  }

  function matchesSpecialist(hospital) {
    if (!state.selectedSpecialists.size) return true;
    return [...state.selectedSpecialists].some((code) => {
      if (code === "general") {
        return hospital.generalDoctorCount > 0 || hospital.specialistTotal === 0;
      }
      const department = departmentFor(hospital, code);
      return Boolean(department && department.specialists > 0);
    });
  }

  function applyFilters() {
    const query = normalizeSearch(state.query);
    const origin = state.userLocation || state.mapCenter;
    const selectedEquipment = [...state.selectedEquipment];

    state.filtered = state.hospitals
      .filter((hospital) => state.selectedTypes.has(hospital.type))
      .filter((hospital) => {
        if (!query) return true;
        return normalizeSearch([
          hospital.name,
          hospital.address,
          hospital.district,
          hospital.type,
          ...(hospital.designations || []),
        ].join(" ")).includes(query);
      })
      .filter((hospital) => {
        if (!state.selectedDepartments.size) return true;
        return hospital.departments.some((department) => state.selectedDepartments.has(department.code));
      })
      .filter(matchesSpecialist)
      .filter((hospital) => selectedEquipment.every((code) => (hospital.equipment?.[code] || 0) > 0))
      .map((hospital) => ({ ...hospital, distanceKm: haversineKm(origin, hospital) }));

    state.filtered.sort((first, second) => {
      if (state.sort === "name") return first.name.localeCompare(second.name, "ko-KR");
      return first.distanceKm - second.distanceKm || first.name.localeCompare(second.name, "ko-KR");
    });

    updateFilterSummaries();
    renderResultHeader();
    renderList();
    renderMarkers();
  }

  function renderResultHeader() {
    dom.resultCount.textContent = `${state.filtered.length.toLocaleString("ko-KR")}곳`;
    const regionCount = state.selectedRegions.size;
    const regionText = regionCount > 1 ? `${regionCount}개 지역에서` : "";
    dom.resultContext.textContent = `${regionText}${state.userLocation ? " 현재 위치 기준으로" : " 지도 중심 기준으로"} 찾았습니다`;
  }

  function selectedEquipmentTags(hospital) {
    if (!state.selectedEquipment.size) {
      const count = Object.keys(hospital.equipment || {}).length;
      return count
        ? `<span class="tag equipment">공개 장비 ${count}종 보유 신고</span>`
        : `<span class="tag neutral">공개 장비 신고 없음</span>`;
    }
    return [...state.selectedEquipment].map((code) =>
      `<span class="tag equipment">${escapeHtml(equipmentLabel(code))} ${hospital.equipment?.[code] || 0}대</span>`
    ).join("");
  }

  function selectedSpecialistTags(hospital) {
    if (!state.selectedSpecialists.size) {
      return hospital.specialistTotal > 0
        ? `<span class="tag specialist">전문의 ${hospital.specialistTotal}명</span>`
        : `<span class="tag neutral">전문의 0명 신고</span>`;
    }
    return [...state.selectedSpecialists].map((code) => {
      if (code === "general") {
        return hospital.generalDoctorCount > 0
          ? `<span class="tag specialist">일반의 ${hospital.generalDoctorCount}명</span>`
          : `<span class="tag neutral">전문의 없는 등록기관</span>`;
      }
      const department = departmentFor(hospital, code);
      if (!department?.specialists) return "";
      return `<span class="tag specialist">${escapeHtml(department.name)} ${department.specialists}명</span>`;
    }).join("");
  }

  function renderHospitalCard(hospital) {
    const designation = hospital.designations?.[0]
      ? `<span class="tag designation">전문병원 지정: ${escapeHtml(hospital.designations[0])}</span>`
      : "";
    return `
      <article class="hospital-card" data-id="${escapeHtml(hospital.id)}">
        <button class="card-open-button" type="button" data-action="open-detail" data-id="${escapeHtml(hospital.id)}" aria-label="${escapeHtml(hospital.name)} 정보 보기">
          <div class="card-main">
            <div class="card-kicker">
              <span class="type-badge ${typeClass(hospital.type)}">${escapeHtml(hospital.type)}</span>
              <span class="distance-badge">${formatDistance(hospital.distanceKm)}</span>
            </div>
            <div class="card-title-row">
              <h3 class="card-title">${escapeHtml(hospital.name)}</h3>
              <span class="card-open-cue">정보 보기</span>
            </div>
            <p class="card-address">${escapeHtml(hospital.address)}</p>
            <div class="tag-row">
              <span class="tag neutral">의사 ${hospital.doctorTotal}명</span>
              <span class="tag neutral">일반의 ${hospital.generalDoctorCount}명</span>
              <span class="tag neutral">진료과목 ${hospital.departments.length}개</span>
            </div>
            <div class="tag-row">${selectedSpecialistTags(hospital)}</div>
            <div class="tag-row">${selectedEquipmentTags(hospital)}${designation}</div>
          </div>
        </button>
      </article>`;
  }

  function renderList() {
    if (state.loading) {
      renderEmpty("병원 데이터를 불러오는 중입니다", "잠시만 기다려 주세요.");
      return;
    }
    if (!state.selectedRegions.size) {
      renderEmpty("지역을 선택해 주세요", "필터를 열고 한 곳 이상의 지역을 체크해 주세요.");
      dom.listFooter.textContent = "";
      return;
    }
    if (!state.selectedTypes.size) {
      renderEmpty("기관유형을 선택해 주세요", "필터에서 한 곳 이상의 기관유형을 체크해 주세요.");
      dom.listFooter.textContent = "";
      return;
    }
    if (!state.filtered.length) {
      renderEmpty("조건에 맞는 병원이 없습니다", "체크한 조건을 일부 해제하거나 다른 지역을 추가해 보세요. 필터는 자동으로 완화하지 않습니다.");
      dom.listFooter.textContent = "";
      return;
    }
    const visible = state.filtered.slice(0, MAX_LIST_RESULTS);
    dom.results.innerHTML = visible.map(renderHospitalCard).join("");
    dom.listFooter.textContent = state.filtered.length > MAX_LIST_RESULTS
      ? `목록은 상위 ${MAX_LIST_RESULTS}곳까지 표시합니다. 검색어나 필터를 추가하면 결과가 좁혀집니다.`
      : "방문 전 전화로 진료 가능 여부와 장비 운영 여부를 확인하세요.";
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
    if (state.loading || !state.filtered.length) {
      if (!state.loading) dom.mapStatus.textContent = state.selectedRegions.size
        ? "필터 조건에 맞는 지도 결과가 없습니다."
        : "지역을 한 곳 이상 선택해 주세요.";
      return;
    }

    const bounds = map.getBounds().pad(0.3);
    let candidates = state.filtered.filter((hospital) => bounds.contains([hospital.lat, hospital.lng]));
    if (!candidates.length) candidates = state.filtered;
    candidates = candidates
      .map((hospital) => ({ hospital, centerDistance: map.distance(map.getCenter(), [hospital.lat, hospital.lng]) }))
      .sort((first, second) => first.centerDistance - second.centerDistance)
      .slice(0, MAX_MAP_MARKERS)
      .map((entry) => entry.hospital);

    const markers = candidates.map((hospital) => {
      const marker = L.marker([hospital.lat, hospital.lng], {
        icon: markerIcon(hospital),
        title: hospital.name,
      });
      marker.bindTooltip(`<b>${escapeHtml(hospital.name)}</b><br>${escapeHtml(hospital.type)} · ${formatDistance(hospital.distanceKm)}`, {
        direction: "top",
        offset: [0, -20],
      });
      marker.on("click", () => openHospitalDetail(hospital.id));
      return marker;
    });
    markerLayer.addLayers(markers);

    const suffix = state.filtered.length > candidates.length
      ? ` · 지도에는 중심 주변 ${candidates.length.toLocaleString("ko-KR")}곳 표시`
      : "";
    dom.mapStatus.textContent = `필터 결과 ${state.filtered.length.toLocaleString("ko-KR")}곳${suffix}`;
  }

  function detailList(items, emptyText, extraClass = "") {
    if (!items.length) return `<p class="detail-empty">${escapeHtml(emptyText)}</p>`;
    return `<ul class="detail-list ${extraClass}">${items.join("")}</ul>`;
  }

  function openHospitalDetail(id) {
    const hospital = state.filtered.find((item) => item.id === id)
      || state.hospitals.find((item) => item.id === id);
    if (!hospital) return;

    const departmentItems = [...hospital.departments]
      .sort((first, second) => second.specialists - first.specialists || first.name.localeCompare(second.name, "ko-KR"))
      .map((department) => `<li><span>${escapeHtml(department.name)} <small>등록</small></span><b>전문의 ${department.specialists}명</b></li>`);
    const equipmentItems = Object.entries(hospital.equipment || {})
      .map(([code, quantity]) => ({ code, quantity, name: equipmentLabel(code) }))
      .sort((first, second) => first.name.localeCompare(second.name, "ko-KR"))
      .map((item) => `<li><span>${escapeHtml(item.name)}</span><b>${item.quantity.toLocaleString("ko-KR")}대</b></li>`);
    const phoneHref = hospital.phone ? `tel:${hospital.phone.replace(/[^0-9+]/g, "")}` : "";
    const navigationUrl = `https://map.naver.com/p/search/${encodeURIComponent(`${hospital.name} ${hospital.address}`)}`;
    const website = websiteUrl(hospital.website);
    const designations = (hospital.designations || []).map((designation) => `<span class="tag designation">${escapeHtml(designation)}</span>`).join("");

    dom.detailDialogContent.innerHTML = `
      <div class="detail-heading">
        <span class="type-badge ${typeClass(hospital.type)}">${escapeHtml(hospital.type)}</span>
        <h2>${escapeHtml(hospital.name)}</h2>
        <p>${escapeHtml(hospital.address)}</p>
        ${designations ? `<div class="tag-row">${designations}</div>` : ""}
      </div>
      <div class="detail-facts">
        <div class="detail-fact"><small>총 의사 수</small><strong>${hospital.doctorTotal}명</strong></div>
        <div class="detail-fact"><small>일반의 수</small><strong>${hospital.generalDoctorCount}명</strong></div>
        <div class="detail-fact"><small>전문의 수</small><strong>${hospital.specialistTotal}명</strong></div>
      </div>
      <div class="detail-grid">
        <section>
          <h3>진료과목 등록과 전문의</h3>
          ${detailList(departmentItems, "공개된 진료과목 데이터가 없습니다.")}
          <p class="detail-note">등록 과목과 전문의 수는 현재 진료 가능 여부나 의료서비스의 질을 뜻하지 않습니다.</p>
        </section>
        <section>
          <h3>장비 보유 신고</h3>
          ${detailList(equipmentItems, "공개된 장비 보유 신고가 없습니다.", "detail-equipment-list")}
          <p class="detail-note">2024-12-31 기준 신고 대수입니다. 현재 사용·예약 가능 여부는 의료기관에 확인하세요.</p>
        </section>
      </div>
      <div class="detail-actions">
        ${phoneHref ? `<a class="primary-action" href="${phoneHref}">전화 ${escapeHtml(hospital.phone)}</a>` : `<button type="button" disabled>전화번호 없음</button>`}
        <a href="${navigationUrl}" target="_blank" rel="noopener noreferrer">네이버지도 열기</a>
        ${website ? `<a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer">홈페이지</a>` : `<button type="button" data-action="copy-address" data-address="${escapeHtml(hospital.address)}">주소 복사</button>`}
      </div>`;
    dom.detailDialog.showModal();
  }

  function findRegionForLocation(location) {
    if (!state.manifest) return null;
    const containing = state.manifest.regions.find((region) => {
      const bounds = region.bounds;
      return bounds
        && location.lat >= bounds.south && location.lat <= bounds.north
        && location.lng >= bounds.west && location.lng <= bounds.east;
    });
    if (containing) return containing;
    return state.manifest.regions
      .map((region) => {
        const bounds = region.bounds;
        const center = { lat: (bounds.south + bounds.north) / 2, lng: (bounds.west + bounds.east) / 2 };
        return { region, distance: haversineKm(location, center) };
      })
      .sort((first, second) => first.distance - second.distance)[0]?.region || null;
  }

  function setUserLocation(location) {
    state.userLocation = location;
    if (state.userMarker) map.removeLayer(state.userMarker);
    state.userMarker = L.marker([location.lat, location.lng], {
      icon: L.divIcon({ className: "user-location-marker", iconSize: [19, 19], iconAnchor: [9, 9] }),
      zIndexOffset: 2000,
      title: "현재 위치",
    }).addTo(map);
    state.userMarker.bindTooltip("현재 위치", { direction: "top" });
  }

  function geolocate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation unavailable"));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: false,
        timeout: 9000,
        maximumAge: 300000,
      });
    });
  }

  async function requestLocation({ automatic = false } = {}) {
    dom.locationButton.disabled = true;
    dom.mapStatus.textContent = "현재 위치를 확인하고 있습니다.";
    try {
      const position = await geolocate();
      const location = { lat: position.coords.latitude, lng: position.coords.longitude };
      setUserLocation(location);
      const region = findRegionForLocation(location) || regionByCode(SEOUL_CODE);
      if (region) {
        state.selectedRegions.clear();
        state.selectedRegions.add(region.code);
        state.initialRegionCode = region.code;
        renderRegionFilters();
        updateFilterSummaries();
        await loadSelectedRegions({ fit: false });
      }
      map.setView([location.lat, location.lng], 14);
      applyFilters();
      showBanner("");
    } catch (error) {
      console.warn("Location unavailable", error?.code || error?.message);
      if (!automatic) {
        showBanner("현재 위치를 확인하지 못했습니다. 지도 중심을 기준으로 거리를 계산합니다.");
      }
      if (!state.selectedRegions.size) {
        const fallback = regionByCode(SEOUL_CODE) || state.manifest?.regions[0];
        if (fallback) {
          state.selectedRegions.clear();
          state.selectedRegions.add(fallback.code);
          state.initialRegionCode = fallback.code;
          renderRegionFilters();
          updateFilterSummaries();
          await loadSelectedRegions({ fit: true });
        }
      }
    } finally {
      dom.locationButton.disabled = false;
    }
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

  function updateSetFromCheckbox(selected, input) {
    if (input.checked) selected.add(input.value);
    else selected.delete(input.value);
  }

  function bindChecklist(container, selected, callback = applyFilters) {
    container.addEventListener("change", (event) => {
      if (!(event.target instanceof HTMLInputElement)) return;
      updateSetFromCheckbox(selected, event.target);
      updateFilterSummaries();
      callback();
    });
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
    dom.filterToggle.addEventListener("click", () => {
      const expanded = dom.filterToggle.getAttribute("aria-expanded") === "true";
      dom.filterToggle.setAttribute("aria-expanded", String(!expanded));
      dom.filterPanel.hidden = expanded;
    });

    bindChecklist(dom.typeFilters, state.selectedTypes);
    bindChecklist(dom.departmentFilters, state.selectedDepartments);
    bindChecklist(dom.specialistFilters, state.selectedSpecialists);
    bindChecklist(dom.equipmentFilters, state.selectedEquipment);
    bindChecklist(dom.regionFilters, state.selectedRegions, () => loadSelectedRegions({ fit: true }));

    dom.resetFilters.addEventListener("click", async () => {
      state.selectedTypes.clear();
      TYPE_LABELS.forEach((type) => state.selectedTypes.add(type));
      state.selectedDepartments.clear();
      state.selectedSpecialists.clear();
      state.selectedEquipment.clear();
      state.query = "";
      dom.searchInput.value = "";
      const resetRegion = regionByCode(state.initialRegionCode) || regionByCode(SEOUL_CODE) || state.manifest?.regions[0];
      state.selectedRegions.clear();
      if (resetRegion) state.selectedRegions.add(resetRegion.code);
      renderRegionFilters();
      renderTypeFilters();
      renderDepartmentFilters();
      renderSpecialistFilters();
      renderEquipmentFilters();
      updateFilterSummaries();
      await loadSelectedRegions({ fit: true });
    });

    dom.sortTabs.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-sort]");
      if (!button) return;
      state.sort = button.dataset.sort;
      dom.sortTabs.querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
      applyFilters();
    });

    dom.results.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action='open-detail']");
      if (button) openHospitalDetail(button.dataset.id);
    });
    dom.detailDialogContent.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action='copy-address']");
      if (button) copyAddress(button.dataset.address || "");
    });
    dom.openInfo.addEventListener("click", () => dom.infoDialog.showModal());
    [dom.infoDialog, dom.detailDialog].forEach((dialog) => dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    }));

    map.on("moveend", () => {
      const center = map.getCenter();
      state.mapCenter = { lat: center.lat, lng: center.lng };
      window.clearTimeout(state.renderTimer);
      state.renderTimer = window.setTimeout(applyFilters, 140);
    });
  }

  async function initialize() {
    bindEvents();
    renderTypeFilters();
    renderEmpty("공식 병원 데이터를 준비하고 있습니다", "현재 위치 권한을 허용하면 주변 병원을 먼저 보여드립니다.");

    try {
      const [manifest, departmentPayload, equipmentPayload] = await Promise.all([
        fetchJson("data/manifest.json"),
        fetchJson("data/departments.json"),
        fetchJson("data/equipment.json"),
      ]);
      state.manifest = manifest;
      state.departments = departmentPayload.departments || [];
      state.equipmentCatalog = equipmentPayload.equipment || [];
      state.equipmentByCode = new Map(state.equipmentCatalog.map((item) => [item.code, item]));
      renderRegionFilters();
      renderDepartmentFilters();
      renderSpecialistFilters();
      renderEquipmentFilters();
      updateFilterSummaries();
      dom.mapStatus.textContent = `전국 ${state.manifest.totalHospitals.toLocaleString("ko-KR")}곳 · 공개 장비 ${state.equipmentCatalog.length.toLocaleString("ko-KR")}종`;
      await requestLocation({ automatic: true });
    } catch (error) {
      console.error(error);
      showBanner("정적 데이터를 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
      renderEmpty("데이터를 불러오지 못했습니다", "페이지 새로고침 후에도 문제가 계속되면 GitHub 저장소의 이슈로 알려주세요.");
      dom.mapStatus.textContent = "데이터 연결 오류";
    }
  }

  initialize();
})();
