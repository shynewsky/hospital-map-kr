"""Validate generated static hospital data before deployment."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
MINIMUM_EXPECTED_HOSPITALS = 40_000
MAX_REGION_FILE_BYTES = 20 * 1024 * 1024


def fail(message: str):
    raise SystemExit(f"VALIDATION FAILED: {message}")


def main():
    manifest_path = DATA / "manifest.json"
    departments_path = DATA / "departments.json"
    if not manifest_path.exists() or not departments_path.exists():
        fail("manifest.json or departments.json is missing")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    regions = manifest.get("regions", [])
    if len(regions) < 16:
        fail(f"expected at least 16 regions, found {len(regions)}")

    declared_total = int(manifest.get("totalHospitals", 0))
    if declared_total < MINIMUM_EXPECTED_HOSPITALS:
        fail(f"hospital count dropped to {declared_total}")

    ids = set()
    counted_total = 0
    for region in regions:
        path = ROOT / region["url"]
        if not path.exists():
            fail(f"missing region file: {path}")
        if path.stat().st_size > MAX_REGION_FILE_BYTES:
            fail(f"region file exceeds 20 MiB: {path.name}")
        payload = json.loads(path.read_text(encoding="utf-8"))
        hospitals = payload.get("hospitals", [])
        if len(hospitals) != int(region["count"]):
            fail(f"count mismatch for {region['code']}")
        counted_total += len(hospitals)

        for hospital in hospitals:
            hospital_id = hospital.get("id")
            if not hospital_id or hospital_id in ids:
                fail(f"missing or duplicate id: {hospital_id}")
            ids.add(hospital_id)
            latitude = hospital.get("lat")
            longitude = hospital.get("lng")
            if not (33 <= latitude <= 39.5 and 124 <= longitude <= 132):
                fail(f"invalid coordinate for {hospital_id}")
            if hospital.get("doctorTotal", 0) < 0:
                fail(f"negative doctor count for {hospital_id}")
            for department in hospital.get("departments", []):
                if department.get("specialists", 0) < 0:
                    fail(f"negative specialist count for {hospital_id}")
            for quantity in hospital.get("equipment", {}).values():
                if quantity < 0:
                    fail(f"negative equipment count for {hospital_id}")

    if counted_total != declared_total:
        fail(f"manifest total {declared_total} does not match files {counted_total}")

    print(f"Validated {counted_total:,} hospitals across {len(regions)} regions.")


if __name__ == "__main__":
    main()
