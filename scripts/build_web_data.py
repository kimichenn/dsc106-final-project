"""
Build the JSON data the prototype web page consumes:

  data/goes_frames.json   - 15-minute animation frames of GOES fire detections,
                            plus precomputed FRP pulse and cumulative-area series
  data/socal_basemap.json - clipped Southern California county outlines (basemap)
"""

import json
import os

import geopandas as gpd
import pandas as pd
from shapely.geometry import box

HERE = os.path.dirname(__file__)
CSV = os.path.join(HERE, "..", "data", "goes_la_fires.csv")
DATA = os.path.join(HERE, "..", "data")
FRAME_MIN = 15
FIRE_IDX = {"Palisades": 0, "Eaton": 1}
VIEW = dict(lon=(-118.78, -117.95), lat=(33.98, 34.34))


def build_frames():
    df = pd.read_csv(CSV, parse_dates=["time"])
    df = df[df.fire.isin(FIRE_IDX)].copy()
    df["local"] = df["time"] - pd.Timedelta(hours=8)
    df["frame"] = df["local"].dt.floor(f"{FRAME_MIN}min")

    grid = pd.date_range(df.frame.min(), df.frame.max(),
                         freq=f"{FRAME_MIN}min")
    frames, pulse_p, pulse_e, cum = [], [], [], []
    seen = set()

    for t in grid:
        chunk = df[df.frame == t]
        # one entry per pixel: brightest detection in the 15-min window
        dets, frame_p, frame_e = [], 0.0, 0.0
        if len(chunk):
            px = chunk.groupby(["lat", "lon", "fire"],
                               as_index=False)["power_mw"].max()
            for r in px.itertuples():
                dets.append([round(r.lat, 4), round(r.lon, 4),
                             int(round(r.power_mw)), FIRE_IDX[r.fire]])
                seen.add((round(r.lat, 3), round(r.lon, 3)))
            frame_p = px[px.fire == "Palisades"].power_mw.sum() / 1000
            frame_e = px[px.fire == "Eaton"].power_mw.sum() / 1000
        frames.append({"t": t.strftime("%Y-%m-%dT%H:%M"), "d": dets})
        pulse_p.append(round(frame_p, 3))
        pulse_e.append(round(frame_e, 3))
        cum.append(round(len(seen) * 4.0, 1))

    out = {
        "meta": {
            "frameMinutes": FRAME_MIN,
            "lonMin": VIEW["lon"][0], "lonMax": VIEW["lon"][1],
            "latMin": VIEW["lat"][0], "latMax": VIEW["lat"][1],
            "startLocal": frames[0]["t"], "endLocal": frames[-1]["t"],
            "nFrames": len(frames),
        },
        "frames": frames,
        "pulse": {"Palisades": pulse_p, "Eaton": pulse_e},
        "cumKm2": cum,
    }
    path = os.path.join(DATA, "goes_frames.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    kb = os.path.getsize(path) / 1024
    print(f"goes_frames.json: {len(frames)} frames, {kb:.0f} KB")
    print(f"  span {frames[0]['t']} .. {frames[-1]['t']} PST")
    print(f"  peak pulse: Palisades {max(pulse_p):.1f} GW, Eaton {max(pulse_e):.1f} GW")
    print(f"  final cumulative: {cum[-1]:.0f} km2")


def build_basemap():
    url = ("https://raw.githubusercontent.com/plotly/datasets/master/"
           "geojson-counties-fips.json")
    counties = gpd.read_file(url)
    print("county columns:", list(counties.columns))
    socal = counties[(counties["STATE"] == "06")
                     & (counties["COUNTY"].isin(
                         ["037", "059", "065", "071", "111"]))]
    clipped = gpd.clip(socal, box(-119.25, 33.55, -117.45, 34.7))
    clipped = clipped[["NAME", "geometry"]]
    path = os.path.join(DATA, "socal_basemap.json")
    clipped.to_file(path, driver="GeoJSON")
    kb = os.path.getsize(path) / 1024
    print(f"socal_basemap.json: {len(clipped)} counties, {kb:.0f} KB")


if __name__ == "__main__":
    build_frames()
    build_basemap()
