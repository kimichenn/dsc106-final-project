"""
Fetch GOES-16 ABI-L2-FDCC (Fire / Hot-Spot Characterization) detections for the
January 2025 Los Angeles wildfires (Palisades + Eaton) and extract every fire
pixel inside the LA basin into a single tidy CSV.

Data source: NOAA GOES on AWS Open Data Registry (anonymous S3 access).
Product:     ABI-L2-FDCC  (CONUS, 2 km, ~every 5 minutes)
Window:      2025-01-07 .. 2025-01-11  (DOY 007-011)
"""

import os
import io
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed

import numpy as np
import pandas as pd
import s3fs
import xarray as xr

BUCKET = "noaa-goes16/ABI-L2-FDCC/2025"
DAYS = ["007", "008", "009", "010", "011"]
LA_BOX = dict(lat_min=33.4, lat_max=34.9, lon_min=-119.3, lon_max=-117.3)
OUT_CSV = os.path.join(os.path.dirname(__file__), "..", "data", "goes_la_fires.csv")

fs = s3fs.S3FileSystem(anon=True)


def fixed_grid_to_latlon(x, y, proj):
    """Vectorized GOES-R fixed-grid (scan angle radians) -> lat/lon degrees."""
    req = proj.semi_major_axis
    rpol = proj.semi_minor_axis
    H = proj.perspective_point_height + req
    lon0 = np.radians(proj.longitude_of_projection_origin)

    xx, yy = np.meshgrid(x, y)
    a = (np.sin(xx) ** 2
         + np.cos(xx) ** 2 * (np.cos(yy) ** 2
                              + (req ** 2 / rpol ** 2) * np.sin(yy) ** 2))
    b = -2 * H * np.cos(xx) * np.cos(yy)
    c = H ** 2 - req ** 2
    disc = b ** 2 - 4 * a * c
    with np.errstate(invalid="ignore"):
        rs = (-b - np.sqrt(disc)) / (2 * a)
        sx = rs * np.cos(xx) * np.cos(yy)
        sy = -rs * np.sin(xx)
        sz = rs * np.cos(xx) * np.sin(yy)
        lat = np.degrees(np.arctan((req ** 2 / rpol ** 2)
                                   * sz / np.sqrt((H - sx) ** 2 + sy ** 2)))
        lon = np.degrees(lon0 - np.arctan(sy / (H - sx)))
    return lat, lon


def build_la_window():
    """Download one file, compute the lat/lon grid, return the LA crop indices."""
    ref = fs.ls(f"{BUCKET}/{DAYS[0]}/18")[0]
    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
        fs.get(ref, tmp.name)
        path = tmp.name
    ds = xr.open_dataset(path)
    lat, lon = fixed_grid_to_latlon(ds["x"].values, ds["y"].values,
                                    ds["goes_imager_projection"])
    ds.close()
    os.unlink(path)

    inbox = ((lat >= LA_BOX["lat_min"]) & (lat <= LA_BOX["lat_max"])
             & (lon >= LA_BOX["lon_min"]) & (lon <= LA_BOX["lon_max"]))
    rows = np.any(inbox, axis=1)
    cols = np.any(inbox, axis=0)
    r0, r1 = np.argmax(rows), len(rows) - np.argmax(rows[::-1])
    c0, c1 = np.argmax(cols), len(cols) - np.argmax(cols[::-1])
    return (r0, r1, c0, c1), lat[r0:r1, c0:c1], lon[r0:r1, c0:c1]


def process_file(key, win, lat_crop, lon_crop):
    """Download one FDCC file, return a DataFrame of LA-box fire pixels."""
    r0, r1, c0, c1 = win
    try:
        data = fs.cat(key)
    except Exception:
        return None
    try:
        ds = xr.open_dataset(io.BytesIO(data), engine="h5netcdf")
    except Exception:
        return None

    power = ds["Power"].values[r0:r1, c0:c1]
    temp = ds["Temp"].values[r0:r1, c0:c1]
    area = ds["Area"].values[r0:r1, c0:c1]
    mask = ds["Mask"].values[r0:r1, c0:c1]
    t = pd.Timestamp(ds["time_bounds"].values[0])
    ds.close()

    valid = ~np.isnan(power)
    if not valid.any():
        return None
    idx = np.where(valid)
    return pd.DataFrame({
        "time": t,
        "lat": lat_crop[idx],
        "lon": lon_crop[idx],
        "power_mw": power[idx],
        "temp_k": temp[idx],
        "area_m2": area[idx],
        "mask": mask[idx],
    })


def main():
    win, lat_crop, lon_crop = build_la_window()
    print(f"LA window shape: {lat_crop.shape}  "
          f"(rows {win[0]}:{win[1]}, cols {win[2]}:{win[3]})")

    keys = []
    for d in DAYS:
        for h in range(24):
            try:
                keys.extend(fs.ls(f"{BUCKET}/{d}/{h:02d}"))
            except FileNotFoundError:
                pass
    print(f"Total FDCC files to scan: {len(keys)}")

    frames = []
    done = 0
    with ThreadPoolExecutor(max_workers=24) as ex:
        futs = {ex.submit(process_file, k, win, lat_crop, lon_crop): k
                for k in keys}
        for fut in as_completed(futs):
            df = fut.result()
            if df is not None:
                frames.append(df)
            done += 1
            if done % 200 == 0:
                print(f"  scanned {done}/{len(keys)}")

    out = pd.concat(frames, ignore_index=True).sort_values("time")
    # Classify each pixel by which fire-complex footprint it falls inside.
    # Boxes were drawn from the observed detection clusters; pixels outside
    # both boxes are other January 2025 SoCal fires (Hurst, Kenneth, ...) or
    # isolated hot pixels and are labelled "Other".
    FIRE_BOXES = {
        "Palisades": dict(lat=(33.98, 34.20), lon=(-118.72, -118.42)),
        "Eaton":     dict(lat=(34.10, 34.33), lon=(-118.27, -117.97)),
    }

    def classify(row):
        for name, b in FIRE_BOXES.items():
            if (b["lat"][0] <= row.lat <= b["lat"][1]
                    and b["lon"][0] <= row.lon <= b["lon"][1]):
                return name
        return "Other"

    out["fire"] = out.apply(classify, axis=1)

    # Drop pre-ignition stray pixels: a detection is "stray" if no other
    # detection of the same fire occurs within the next 30 minutes. This
    # removes isolated low-power hot pixels that precede sustained ignition.
    keep = []
    for name, g in out.groupby("fire"):
        g = g.sort_values("time")
        if name == "Other":
            keep.append(g)
            continue
        times = g["time"].values
        followed = np.array([
            ((times > t) & (times <= t + np.timedelta64(30, "m"))).any()
            for t in times
        ])
        ignition = times[followed][0] if followed.any() else times[0]
        keep.append(g[g["time"] >= ignition])
    out = pd.concat(keep).sort_values("time")

    out.to_csv(OUT_CSV, index=False)
    print(f"\nSaved {len(out)} fire-pixel detections -> {OUT_CSV}")
    print(out.groupby("fire").size())
    print("Time span:", out.time.min(), "->", out.time.max())
    print("Peak FRP (MW):", round(out.power_mw.max(), 1))


if __name__ == "__main__":
    main()
