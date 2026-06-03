"""
Fetch Esri World Imagery tiles covering the fire bounding box, stitch them into
one satellite basemap image, and record its exact geographic bounds so the web
page can drape it under the GOES fire pixels (both use spherical Mercator, so the
image -> screen mapping is a simple affine placement).

Imagery: Esri World Imagery (Esri, Maxar, Earthstar Geographics).
Run inside the dsc106 conda env:  conda run -n dsc106 python3 scripts/fetch_basemap.py
"""
import json, math, os, time, urllib.request

# fire bounding box (from data/goes_frames.json meta)
LON_MIN, LON_MAX = -118.78, -117.95
LAT_MIN, LAT_MAX = 33.98, 34.34
ZOOM = 12
TILE = 256
OUT_IMG = "data/basemap_satellite.jpg"
OUT_BOUNDS = "data/basemap_bounds.json"
URL = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
       "World_Imagery/MapServer/tile/{z}/{y}/{x}")


def lon2xt(lon, n):
    return (lon + 180.0) / 360.0 * n


def lat2yt(lat, n):
    r = math.radians(lat)
    return (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * n


def xt2lon(x, n):
    return x / n * 360.0 - 180.0


def yt2lat(y, n):
    return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))


def main():
    from PIL import Image
    n = 2 ** ZOOM
    x0 = int(math.floor(lon2xt(LON_MIN, n)))
    x1 = int(math.floor(lon2xt(LON_MAX, n)))
    y0 = int(math.floor(lat2yt(LAT_MAX, n)))  # north = smaller y
    y1 = int(math.floor(lat2yt(LAT_MIN, n)))
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    print(f"zoom {ZOOM}: {cols}x{rows} tiles = {cols*rows} fetches")

    canvas = Image.new("RGB", (cols * TILE, rows * TILE))
    for j, yt in enumerate(range(y0, y1 + 1)):
        for i, xt in enumerate(range(x0, x1 + 1)):
            url = URL.format(z=ZOOM, x=xt, y=yt)
            req = urllib.request.Request(url, headers={"User-Agent": "DSC106-student-project/1.0"})
            for attempt in range(3):
                try:
                    data = urllib.request.urlopen(req, timeout=30).read()
                    break
                except Exception as e:
                    if attempt == 2:
                        raise
                    time.sleep(1)
            from io import BytesIO
            canvas.paste(Image.open(BytesIO(data)), (i * TILE, j * TILE))
        print(f"  row {j+1}/{rows} done")

    os.makedirs("data", exist_ok=True)
    canvas.save(OUT_IMG, "JPEG", quality=82, optimize=True, progressive=True)
    bounds = {
        "lonMin": xt2lon(x0, n),
        "lonMax": xt2lon(x1 + 1, n),
        "latMax": yt2lat(y0, n),
        "latMin": yt2lat(y1 + 1, n),
        "width": canvas.width,
        "height": canvas.height,
        "attribution": "Esri, Maxar, Earthstar Geographics",
    }
    with open(OUT_BOUNDS, "w") as f:
        json.dump(bounds, f, indent=2)
    print("saved", OUT_IMG, canvas.size, f"{os.path.getsize(OUT_IMG)//1024}KB")
    print("bounds", bounds)


if __name__ == "__main__":
    main()
