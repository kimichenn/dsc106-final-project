"""
Fetch the Santa Ana wind that drove the Jan 2025 LA fires and align it, frame
for frame, to the GOES animation the web page already plays.

  data/wind.json  - per-frame wind speed / gust / direction, length == nFrames,
                    matching data/goes_frames.json one-to-one.

Source: Open-Meteo ERA5 reanalysis archive (free, no API key). We sample one
representative basin foothill point: the Santa Ana is a regional offshore flow,
so a single basin reading is honest rather than implying fine spatial structure.
This 10 m reanalysis captures the offshore direction and the overnight surge;
the famous 160 km/h figures are local downslope canyon gusts that a ~25 km
reanalysis grid cannot resolve, so we label the data accordingly.
"""

import json
import os
from datetime import datetime, timedelta

import numpy as np
import requests

HERE = os.path.dirname(__file__)
DATA = os.path.join(HERE, "..", "data")
FRAMES = os.path.join(DATA, "goes_frames.json")

# representative basin foothill point, between the Palisades and Eaton fires
LAT, LON = 34.13, -118.30
ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"

DIRS8 = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def cardinal(deg):
    return DIRS8[int((deg % 360) / 45 + 0.5) % 8]


def fetch_hourly(start_date, end_date):
    params = {
        "latitude": LAT,
        "longitude": LON,
        "start_date": start_date,
        "end_date": end_date,
        "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        "wind_speed_unit": "kmh",
        "timezone": "America/Los_Angeles",
    }
    r = requests.get(ARCHIVE, params=params, timeout=60)
    r.raise_for_status()
    return r.json()["hourly"]


def main():
    frames = json.load(open(FRAMES))
    times = [f["t"] for f in frames["frames"]]
    n = len(times)
    frame_dt = [datetime.fromisoformat(t) for t in times]

    # pad a day each side so every frame is bracketed by real hourly samples
    start_date = (frame_dt[0] - timedelta(days=1)).date().isoformat()
    end_date = (frame_dt[-1] + timedelta(days=1)).date().isoformat()

    hourly = fetch_hourly(start_date, end_date)
    hour_dt = [datetime.fromisoformat(t) for t in hourly["time"]]

    ref = frame_dt[0]
    fsec = np.array([(t - ref).total_seconds() for t in frame_dt])
    hsec = np.array([(t - ref).total_seconds() for t in hour_dt])

    speed = np.interp(fsec, hsec, np.array(hourly["wind_speed_10m"], float))
    gust = np.interp(fsec, hsec, np.array(hourly["wind_gusts_10m"], float))
    # circular interpolation for direction (avoids the 359 -> 0 wrap)
    rad = np.deg2rad(np.array(hourly["wind_direction_10m"], float))
    u = np.interp(fsec, hsec, np.sin(rad))
    v = np.interp(fsec, hsec, np.cos(rad))
    direction = (np.rad2deg(np.arctan2(u, v)) + 360) % 360

    out = {
        "meta": {
            "lat": LAT, "lon": LON,
            "source": "Open-Meteo ERA5 reanalysis",
            "speedUnit": "km/h",
            "nFrames": n,
            "note": "basin-scale 10 m wind; local canyon gusts run higher",
        },
        "speed": [round(float(x), 1) for x in speed],
        "gust": [round(float(x), 1) for x in gust],
        "dir": [round(float(x), 1) for x in direction],
    }
    path = os.path.join(DATA, "wind.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    kb = os.path.getsize(path) / 1024
    print(f"wind.json: {n} frames, {kb:.1f} KB  (aligned to goes_frames.json)")

    # summary so the narrative copy can be tuned to what the data actually shows
    gi, si = int(np.argmax(gust)), int(np.argmax(speed))
    print(f"  peak gust  {gust[gi]:4.0f} km/h  {times[gi]} PST  from {cardinal(direction[gi])} ({direction[gi]:.0f} deg)")
    print(f"  peak speed {speed[si]:4.0f} km/h  {times[si]} PST  from {cardinal(direction[si])} ({direction[si]:.0f} deg)")
    for label, i in [("firestorm peak (f51)", 51), ("dawn ease (f75)", 75)]:
        if i < n:
            print(f"  {label:22s} {times[i]} PST  speed {speed[i]:3.0f}  gust {gust[i]:3.0f}  from {cardinal(direction[i])} ({direction[i]:.0f})")


if __name__ == "__main__":
    main()
