"""
Generate the six static proposal figures from the GOES-16 LA wildfire dataset.
Output: ../figures/fig1..fig6 .png

Style goal: each figure is a standalone, publication-quality EDA graphic with an
interpretive title, a descriptive subtitle, annotations, and light gridlines.
"""

import os
import numpy as np
import pandas as pd
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import matplotlib.patheffects as pe

HERE = os.path.dirname(__file__)
CSV = os.path.join(HERE, "..", "data", "goes_la_fires.csv")
FIG = os.path.join(HERE, "..", "figures")

PST = pd.Timedelta(hours=-8)
COL = {"Palisades": "#e8632c", "Eaton": "#7b3fb0"}
VIEW = dict(xlim=(-118.85, -117.85), ylim=(33.92, 34.42))
STROKE = [pe.withStroke(linewidth=2.6, foreground="black")]

plt.rcParams.update(
    {
        "figure.dpi": 130,
        "font.size": 11,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.titlesize": 11,
    }
)

# Fire intensity colormap: pale amber (cool) -> deep red (hottest).
# Truncated YlOrRd so the low end stays visible on a white background.
FIRE_CMAP = matplotlib.colors.LinearSegmentedColormap.from_list(
    "fire", plt.cm.YlOrRd(np.linspace(0.15, 1.0, 256))
)
FIRE_NORM = matplotlib.colors.LogNorm(vmin=10, vmax=4000)

df = pd.read_csv(CSV, parse_dates=["time"])
df["local"] = df["time"] + PST
df["frame"] = df["local"].dt.floor("5min")
fires = df[df.fire.isin(["Palisades", "Eaton"])].copy()
print(
    f"Loaded {len(df)} detections "
    f"(Palisades {len(fires[fires.fire=='Palisades'])}, "
    f"Eaton {len(fires[fires.fire=='Eaton'])}, "
    f"Other {len(df)-len(fires)}); "
    f"{df.local.min():%Y-%m-%d %H:%M} .. {df.local.max():%Y-%m-%d %H:%M} PST"
)


def titled(ax, title, subtitle):
    """Bold interpretive title + grey descriptive subtitle, above the axes."""
    ax.text(
        0.0,
        1.135,
        title,
        transform=ax.transAxes,
        fontsize=14,
        fontweight="bold",
        va="bottom",
    )
    ax.text(
        0.0,
        1.035,
        subtitle,
        transform=ax.transAxes,
        fontsize=10.3,
        color="#5f6368",
        va="bottom",
    )


def ygrid(ax):
    ax.grid(axis="y", color="#ececec", lw=0.9)
    ax.set_axisbelow(True)


def save(fig, name):
    fig.savefig(os.path.join(FIG, name), bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print("  wrote", name)


def frp_gw(group, freq):
    """Continuous total-FRP series (GW): per-5-min-frame sum, 0-filled, resampled."""
    pf = group.groupby("frame")["power_mw"].sum()
    grid = pd.date_range(pf.index.min(), pf.index.max(), freq="5min")
    pf = pf.reindex(grid, fill_value=0.0)
    return pf.resample(freq).mean() / 1000.0 if freq else pf / 1000.0


# ---------------------------------------------------------------- Figure 1
peak = fires.groupby(["lat", "lon", "fire"], as_index=False)["power_mw"].max()
fig, ax = plt.subplots(figsize=(8.4, 6))
sc = ax.scatter(
    peak.lon,
    peak.lat,
    c=peak.power_mw,
    cmap=FIRE_CMAP,
    s=46,
    marker="s",
    edgecolors="#9a9a9a",
    linewidths=0.3,
    norm=FIRE_NORM,
)
# city reference points for spatial anchoring
for city, (la, lo) in {
    "Downtown LA": (34.05, -118.24),
    "Pasadena": (34.15, -118.14),
    "Santa Monica": (34.01, -118.49),
}.items():
    ax.scatter([lo], [la], s=24, c="#bdbdbd", marker="o", zorder=4)
    ax.annotate(
        city,
        (lo, la),
        xytext=(5, -9),
        textcoords="offset points",
        fontsize=8.5,
        color="#666",
    )
for name, (la, lo) in {
    "Palisades": (34.05, -118.55),
    "Eaton": (34.19, -118.13),
}.items():
    ax.scatter(
        [lo],
        [la],
        marker="*",
        s=210,
        c="white",
        edgecolors="black",
        linewidths=0.7,
        zorder=5,
    )
    ax.annotate(
        f"{name} fire",
        (lo, la),
        xytext=(0, 13),
        textcoords="offset points",
        ha="center",
        color="white",
        fontsize=11,
        fontweight="bold",
        zorder=6,
        path_effects=STROKE,
    )
cb = fig.colorbar(sc, ax=ax, label="Peak Fire Radiative Power (MW, log scale)")
ax.set(xlabel="Longitude", ylabel="Latitude", **VIEW)
ax.set_aspect(1.2)
titled(
    ax,
    "Two fires, one basin",
    "Every 2 km pixel GOES-16 flagged as fire across Jan 7–11, 2025",
)
save(fig, "fig1_footprint_map.png")


# ---------------------------------------------------------------- Figure 2
fig, ax = plt.subplots(figsize=(9.2, 4.8))
for name, g in fires.groupby("fire"):
    ts = frp_gw(g, "30min")
    ax.plot(ts.index, ts.values, color=COL[name], lw=2.1, label=f"{name} fire")
ymax = ax.get_ylim()[1]
ax.axvspan(
    pd.Timestamp("2025-01-07 03:00"),
    pd.Timestamp("2025-01-08 06:00"),
    color="#ffd54f",
    alpha=0.22,
    lw=0,
)
ax.text(
    pd.Timestamp("2025-01-07 14:00"),
    ymax * 0.95,
    "peak Santa Ana winds",
    fontsize=9,
    color="#7a5c00",
    style="italic",
    ha="center",
)
ann = dict(boxstyle="round,pad=0.3", fc="white", ec="#999", lw=0.8)
for txt, t in [
    ("Palisades ignites — 10:36 AM", "2025-01-07 10:36"),
    ("Eaton ignites — 6:26 PM", "2025-01-07 18:26"),
]:
    ts = pd.Timestamp(t)
    ax.axvline(ts, color="#777", lw=1, ls=":")
    ax.annotate(
        txt,
        (ts, ymax * 0.50),
        xytext=(8, 0),
        textcoords="offset points",
        fontsize=8.3,
        va="center",
        rotation=90,
        bbox=ann,
    )
ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %-d\n%-I %p"))
ax.set(xlabel="January 2025 (Pacific time)", ylabel="Total Fire Radiative Power (GW)")
ax.legend(frameon=False, loc="upper right")
ygrid(ax)
titled(
    ax,
    "The fire's pulse",
    "Total radiative power surges with the Santa Ana winds, then settles "
    "into a daily rhythm",
)
save(fig, "fig2_frp_timeseries.png")


# ---------------------------------------------------------------- Figure 3
t0 = fires.frame.min()
hours = [0, 6, 12, 24, 48, 72]
fig, axes = plt.subplots(2, 3, figsize=(11.5, 7.6), sharex=True, sharey=True)
fig.subplots_adjust(
    left=0.065, right=0.875, top=0.88, bottom=0.085, wspace=0.13, hspace=0.22
)
for h, ax in zip(hours, axes.flat):
    lo, hi = t0 + pd.Timedelta(hours=h), t0 + pd.Timedelta(hours=h + 1)
    snap = fires[(fires.frame >= lo) & (fires.frame < hi)]
    ax.scatter(fires.lon, fires.lat, s=12, marker="s", color="#e9e9e9")
    if len(snap):
        ax.scatter(
            snap.lon,
            snap.lat,
            c=snap.power_mw,
            cmap=FIRE_CMAP,
            s=36,
            marker="s",
            edgecolors="#7a7a7a",
            linewidths=0.3,
            norm=FIRE_NORM,
        )
    ax.set_title(
        f"+{h} h   –   {lo:%b %-d, %-I %p}", fontsize=10.5, fontweight="bold", pad=4
    )
    ax.set(**VIEW)
    ax.set_aspect(1.25)
axes.flat[0].annotate(
    "first GOES\ndetections",
    (-118.57, 34.08),
    xytext=(-118.30, 34.33),
    fontsize=8.3,
    color="#333",
    ha="center",
    arrowprops=dict(arrowstyle="->", color="#555", lw=1),
)
sm = plt.cm.ScalarMappable(cmap=FIRE_CMAP, norm=FIRE_NORM)
cb = fig.colorbar(sm, cax=fig.add_axes([0.9, 0.18, 0.018, 0.56]))
cb.set_label("Fire Radiative Power (MW, log scale)", fontsize=9.5)
fig.text(0.5, 0.965, "How fast it spread", ha="center", fontsize=15, fontweight="bold")
fig.text(
    0.5,
    0.918,
    "Each square is one 2 km GOES pixel. Grey marks the "
    "full five-day footprint, color marks fire actively burning that "
    "hour",
    ha="center",
    fontsize=10.3,
    color="#5f6368",
)
fig.supxlabel("Longitude", fontsize=10)
fig.supylabel("Latitude", fontsize=10)
save(fig, "fig3_spread_snapshots.png")


# ---------------------------------------------------------------- Figure 4
fires["hour"] = fires.local.dt.hour
diur = fires.groupby(["hour", "fire"])["power_mw"].mean().unstack()
fig, ax = plt.subplots(figsize=(8.4, 4.8))
ax.axvspan(0, 6, color="#e8eaf6", alpha=0.7, lw=0)
ax.axvspan(18, 23, color="#e8eaf6", alpha=0.7, lw=0)
ax.text(
    3,
    ax.get_ylim()[1] if False else 0,
    "",
)
for name in ["Palisades", "Eaton"]:
    ax.plot(
        diur.index,
        diur[name],
        color=COL[name],
        lw=2.2,
        marker="o",
        ms=4.5,
        label=f"{name} fire",
    )
ymax = np.nanmax(diur.values) * 1.05
ax.set_ylim(0, ymax)
ax.text(3, ymax * 0.93, "night", ha="center", fontsize=9, color="#5c6bc0")
ax.text(20.5, ymax * 0.93, "night", ha="center", fontsize=9, color="#5c6bc0")
ax.text(
    13.5,
    ymax * 0.93,
    "afternoon burn peak",
    ha="center",
    fontsize=9,
    color="#7a5c00",
    style="italic",
)
for name in ["Palisades", "Eaton"]:
    ax.annotate(
        f"{name}",
        (23, diur[name].iloc[-1]),
        xytext=(7, 0),
        textcoords="offset points",
        va="center",
        fontsize=10,
        fontweight="bold",
        color=COL[name],
    )
ax.set(
    xlabel="Hour of day (Pacific time)",
    ylabel="Mean radiative power per fire pixel (MW)",
    xticks=range(0, 24, 3),
    xlim=(0, 23),
)
ygrid(ax)
titled(
    ax,
    "A wildfire breathes",
    "Per-pixel intensity climbs through the afternoon heat and ebbs " "overnight",
)
save(fig, "fig4_diurnal_cycle.png")


# ---------------------------------------------------------------- Figure 5
# Why temporal cadence matters: native 5-min GOES vs a twice-daily polar orbiter.
pal = fires[fires.fire == "Palisades"]
native = frp_gw(pal, None)  # 5-min resolution, GW
win = (native.index >= "2025-01-07 06:00") & (native.index <= "2025-01-08 21:00")
native = native[win].rolling(3, center=True, min_periods=1).mean()

# MODIS-class polar-orbiting overpasses (~4 looks/day, approx local times)
overpass_hours = [
    "2025-01-07 10:30",
    "2025-01-07 13:30",
    "2025-01-07 22:30",
    "2025-01-08 01:30",
    "2025-01-08 10:30",
    "2025-01-08 13:30",
    "2025-01-08 20:30",
]
ot = [pd.Timestamp(t) for t in overpass_hours]
ov = [native.iloc[(native.index - t).map(abs).argmin()] for t in ot]

fig, ax = plt.subplots(figsize=(9.2, 4.8))
ax.fill_between(native.index, native.values, color="#e8632c", alpha=0.18, lw=0)
ax.plot(
    native.index,
    native.values,
    color="#e8632c",
    lw=1.5,
    label="GOES-16. Every 5 minutes (288 looks/day)",
)
ax.plot(
    ot,
    ov,
    color="#1f3b73",
    lw=1.6,
    ls="--",
    marker="o",
    ms=8,
    label="Polar orbiter (MODIS-class) ~4 looks/day",
)
# point to where the polar orbiter's straight-line guess is most wrong
polar_line = np.interp(native.index.astype("int64"), [t.value for t in ot], ov)
miss = native.values - polar_line
mi = int(np.argmax(miss))
ax.annotate(
    f"GOES reads {native.values[mi]:.0f} GW here. \n"
    f"The polar orbiter's line guesses {polar_line[mi]:.0f}",
    (native.index[mi], native.values[mi]),
    xytext=(pd.Timestamp("2025-01-08 06:30"), 24),
    textcoords="data",
    fontsize=9,
    ha="left",
    bbox=dict(boxstyle="round,pad=0.3", fc="white", ec="#999", lw=0.8),
    arrowprops=dict(arrowstyle="->", color="#555"),
)
ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %-d\n%-I %p"))
ax.set(
    xlabel="January 2025 (Pacific time)", ylabel="Palisades total radiative power (GW)"
)
ax.legend(frameon=False, loc="upper left")
ygrid(ax)
titled(
    ax,
    "Why five minutes matters",
    "Four daily snapshots reduce a volatile fire to straight lines "
    "drawn between the dots",
)
save(fig, "fig5_cadence_value.png")


# ---------------------------------------------------------------- Figure 6
order = fires.sort_values("time").copy()
seen, cum = set(), []
for la, lo in zip(order.lat.round(3), order.lon.round(3)):
    seen.add((la, lo))
    cum.append(len(seen) * 4.0)
order["cum_km2"] = cum
fig, ax = plt.subplots(figsize=(9.2, 4.8))
ax.fill_between(order.local, order.cum_km2, color="#e8632c", alpha=0.85, lw=0)
day1 = order[order.local < "2025-01-08 00:00"]
ax.annotate(
    f"{day1.cum_km2.iloc[-1]:.0f} km² lit up in the first day alone",
    (day1.local.iloc[-1], day1.cum_km2.iloc[-1]),
    xytext=(14, -34),
    textcoords="offset points",
    fontsize=9,
    bbox=dict(boxstyle="round,pad=0.3", fc="white", ec="#999", lw=0.8),
    arrowprops=dict(arrowstyle="->", color="#555"),
)
final = order.cum_km2.iloc[-1]
ax.annotate(
    f"{final:,.0f} km²",
    (order.local.iloc[-1], final),
    ha="right",
    va="bottom",
    fontweight="bold",
    color="#e8632c",
)
ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %-d\n%-I %p"))
ax.set(
    xlabel="January 2025 (Pacific time)",
    ylabel="Cumulative area with detected fire (km²)",
    ylim=(0, final * 1.12),
)
ygrid(ax)
titled(
    ax,
    "No going back",
    "Every 2 km cell GOES ever flagged as fire. Over half lit up "
    "in the opening 24 hours",
)
save(fig, "fig6_cumulative_area.png")

print("Done.")
