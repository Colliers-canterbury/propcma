"""
Vercel serverless function: regenerates the Christchurch CBD A3 reference
map PDF on demand, using whatever building-name overrides currently sit in
Supabase's cbd_map_labels table (the same table the interactive web map at
/cbd-map reads and writes).

The response is a 2-page PDF: page 1 is the building/street map (live
names), page 2 is a full-bleed satellite/aerial view of the same area,
meant to sit on the flip side when printed double-sided.

Deploy this at api/print-map.py in the repo root, alongside the pre-built
assets in api/_map_data/ (print_buildings.json, print_roads.json,
print_features.json, colliers-logo.png, satellite-base.png -- all produced
once, offline, so this function needs no pyproj / OSM / imagery fetch at
request time -- only the live Supabase read for page 1's names).

Reuses the SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY environment variables
already configured in this Vercel project -- no new secrets needed. The
service-role key is used here, server-side only, specifically so this can
read cbd_map_labels regardless of its RLS policy; it is never sent to the
browser.

GET /api/print-map -> streams back a 2-page PDF (Content-Type: application/pdf).
"""
import datetime
import json
import math
import os
import string
import textwrap
import traceback
import urllib.request
from collections import defaultdict
from http.server import BaseHTTPRequestHandler
from io import BytesIO
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patheffects as pe
import matplotlib.image as mpimg
from matplotlib.backends.backend_pdf import PdfPages
from matplotlib.patches import Polygon as MplPolygon, Rectangle
from matplotlib.collections import PolyCollection, LineCollection

# Path.__file__ resolves relative to the script's own location, not the
# project root (which is what a bare relative open() would use on Vercel).
DATA_DIR = Path(__file__).resolve().parent / "_map_data"

# ================= Colliers palette (must match the original static render) =================
NAVY        = "#0B568F"
NAVY_DARK   = "#083E67"
GOLD        = "#FDB934"
CYAN        = "#1CA4DE"
RED         = "#E9212C"

MAP_BG      = "#FCFCFA"

LU = {
    "Commercial":  ("#FCD989", "#C79A3E"),
    "Retail":      ("#FFF428", "#C7B800"),
    "Apartments":  ("#14B2C6", "#0C7E8D"),
    "Hotels":      ("#FFBB38", "#C4860C"),
    "Bars":        ("#FA832E", "#B85A16"),
    "Industrial":  ("#B93794", "#7F2367"),
    "Clubs":       ("#7CA5D6", "#4B70A3"),
    "Development": ("#D5E4E7", "#A9BDC2"),
    "Parking":     ("#93DEFE", "#4FA9CE"),
}
PARK_FILL, PARK_EDGE   = "#A5C57D", "#71943F"
WATER_FILL, WATER_EDGE = "#5FCBEC", "#1CA4DE"
ROAD_COLOR   = "#8b93a0"
ROAD_CASING  = "#ffffff"
LABEL_TEXT   = NAVY_DARK
LABEL_HALO   = "#ffffff"
ROAD_LABEL   = "#20242b"
ROAD_LABEL_HALO = "#ffffff"

MAJOR = {"primary", "primary_link", "secondary", "secondary_link", "tertiary", "tertiary_link"}
MINOR = {"residential", "unclassified", "living_street"}
SERVICE = {"service", "pedestrian", "footway", "cycleway", "path", "track"}


# ================= Supabase overrides =================
def fetch_overrides():
    """Return {building_id: text} from cbd_map_labels, or {} on any failure
    (missing env vars, network error, etc). The PDF should still render with
    plain OSM names rather than 500ing when Supabase is unreachable."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return {}
    endpoint = url.rstrip("/") + "/rest/v1/cbd_map_labels?select=building_id,text"
    req = urllib.request.Request(endpoint, headers={
        "apikey": key,
        "Authorization": "Bearer " + key,
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            rows = json.loads(resp.read().decode("utf-8"))
        return {row["building_id"]: row.get("text", "") for row in rows}
    except Exception:
        return {}


def resolved_label(b, overrides):
    """Same precedence as the web map's displayName(): an explicit override
    (even an empty one, meaning 'name removed on the map') always wins over
    the OSM name. Falls back to a house-number label only when there is
    neither an override nor an OSM name -- matching the original static map."""
    if b["id"] in overrides:
        text = overrides[b["id"]]
        if not text:
            return None, None
        return text, "name"
    if b["name"]:
        return b["name"], "name"
    if b["housenumber"]:
        return b["housenumber"], "num"
    return None, None


# ================= Label placement (ported from labels.py, run fresh each request) =================
class Occupancy:
    def __init__(self, xmin, xmax, ymin, ymax):
        self.rects = []
        self.xmin, self.xmax, self.ymin, self.ymax = xmin, xmax, ymin, ymax

    def free(self, x0, y0, x1, y1):
        if x0 < self.xmin or x1 > self.xmax or y0 < self.ymin or y1 > self.ymax:
            return False
        for (a0, b0, a1, b1) in self.rects:
            if not (x1 < a0 or x0 > a1 or y1 < b0 or y0 > b1):
                return False
        return True

    def add(self, x0, y0, x1, y1):
        self.rects.append((x0, y0, x1, y1))


def spiral_offsets(n_rings=6, n_angles=12):
    yield (0.0, 0.0, 0)
    for ring in range(1, n_rings + 1):
        for a in range(n_angles):
            theta = 2 * math.pi * a / n_angles + (0.4 if ring % 2 else 0.0)
            yield (math.cos(theta), math.sin(theta), ring)


OFFSETS = list(spiral_offsets())


def place_labels(buildings, overrides, xmin, xmax, ymin, ymax):
    candidates = []
    for b in buildings:
        text, kind = resolved_label(b, overrides)
        if not text:
            continue
        candidates.append({"cx": b["cx"], "cy": b["cy"], "text": text, "kind": kind, "area": b["area"]})
    candidates.sort(key=lambda c: -c["area"])

    occ = Occupancy(xmin, xmax, ymin, ymax)

    WIDTH_IN_INCHES = 420 / 25.4 * (1 - 0.02 - 0.02)
    DATA_PER_POINT = (xmax - xmin) / WIDTH_IN_INCHES / 72.0
    CHAR_W_FACTOR = 0.62
    LINE_H_FACTOR = 1.35

    def text_box(text, fontsize_pt, max_chars_per_line):
        lines = textwrap.wrap(text, max_chars_per_line) or [text]
        n_lines = len(lines)
        longest = max(len(l) for l in lines)
        w = longest * fontsize_pt * CHAR_W_FACTOR * DATA_PER_POINT
        h = n_lines * fontsize_pt * LINE_H_FACTOR * DATA_PER_POINT
        return lines, w, h

    placed = []
    PAD = 1.1

    for c in candidates:
        fontsize = 5.4 if c["kind"] == "name" else 4.2
        max_chars = 15 if c["kind"] == "name" else 6
        lines, w, h = text_box(c["text"], fontsize, max_chars)
        diag = (w ** 2 + h ** 2) ** 0.5
        for (ux, uy, ring) in OFFSETS:
            dist = ring * (diag * 0.62 + PAD)
            x0 = c["cx"] + ux * dist - w / 2
            y0 = c["cy"] + uy * dist - h / 2
            x1, y1 = x0 + w, y0 + h
            if occ.free(x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD):
                occ.add(x0 - PAD, y0 - PAD, x1 + PAD, y1 + PAD)
                placed.append({
                    "x": (x0 + x1) / 2, "y": (y0 + y1) / 2, "lines": lines,
                    "fontsize": fontsize, "cx": c["cx"], "cy": c["cy"],
                    "leader": ring != 0,
                })
                break
    return placed


# ================= Page 1: the building map (ported from final_render_colliers.py) =================
def build_map_figure(overrides):
    buildings_data = json.load(open(DATA_DIR / "print_buildings.json"))
    bbox = buildings_data["bbox"]
    buildings = buildings_data["buildings"]
    roads = json.load(open(DATA_DIR / "print_roads.json"))["roads"]
    features = json.load(open(DATA_DIR / "print_features.json"))
    water_polys = features["water_polys"]
    water_lines = features["water_lines"]
    parks = features["parks"]

    xmin, xmax, ymin, ymax = bbox["xmin"], bbox["xmax"], bbox["ymin"], bbox["ymax"]

    A3_W_MM, A3_H_MM = 420, 297
    DPI = 300
    fig_w_in, fig_h_in = A3_W_MM / 25.4, A3_H_MM / 25.4
    fig = plt.figure(figsize=(fig_w_in, fig_h_in), dpi=DPI)
    fig.patch.set_facecolor(NAVY)

    MARGIN_TOP = 0.028
    MARGIN_BOTTOM = 0.075
    MARGIN_L = 0.024
    MARGIN_R = 0.024
    ax = fig.add_axes([MARGIN_L, MARGIN_BOTTOM, 1 - MARGIN_L - MARGIN_R, 1 - MARGIN_TOP - MARGIN_BOTTOM])

    ax.set_xlim(xmin, xmax); ax.set_ylim(ymin, ymax)
    ax.set_aspect("equal"); ax.axis("off")
    ax.set_facecolor(MAP_BG)
    ax.add_patch(Rectangle((xmin, ymin), xmax - xmin, ymax - ymin, facecolor=MAP_BG, edgecolor="none", zorder=0))

    for p in parks:
        ax.add_patch(MplPolygon(p["coords"], closed=True, facecolor=PARK_FILL, edgecolor=PARK_EDGE, linewidth=0.35, zorder=1))
    for w in water_polys:
        ax.add_patch(MplPolygon(w, closed=True, facecolor=WATER_FILL, edgecolor=WATER_EDGE, linewidth=0.5, zorder=1.5))
    if water_lines:
        ax.add_collection(LineCollection(water_lines, colors=WATER_FILL, linewidths=3.0, zorder=1.55, capstyle="round"))
        ax.add_collection(LineCollection(water_lines, colors=WATER_EDGE, linewidths=0.9, zorder=1.6, capstyle="round"))

    def road_style(hw):
        if hw in MAJOR: return ROAD_COLOR, 2.0
        if hw in MINOR: return ROAD_COLOR, 1.2
        if hw in SERVICE: return "#b7bdc6", 0.5
        return ROAD_COLOR, 0.8

    by_style = {}
    for r in roads:
        color, lw = road_style(r["hw"])
        by_style.setdefault((color, lw), []).append(r["coords"])
    for (color, lw) in sorted(by_style.keys(), key=lambda k: k[1]):
        ax.add_collection(LineCollection(by_style[(color, lw)], colors=ROAD_CASING, linewidths=lw + 1.4, zorder=1.95, capstyle="round", joinstyle="round"))
        ax.add_collection(LineCollection(by_style[(color, lw)], colors=color, linewidths=lw, zorder=2, capstyle="round", joinstyle="round"))

    by_landuse = defaultdict(list)
    for b in buildings:
        by_landuse[b["landuse"]].append(b["coords"])
    for lu, polys in by_landuse.items():
        fc, ec = LU.get(lu, LU["Commercial"])
        ax.add_collection(PolyCollection(polys, facecolor=fc, edgecolor=ec, linewidths=0.35, zorder=3))

    # ---- road name labels ----
    named_major = [r for r in roads if r["name"] and r["hw"] in (MAJOR | MINOR) and r["length"] > 60]
    by_name = defaultdict(list)
    for r in named_major:
        by_name[r["name"]].append(r)

    road_label_fs = 5.3
    for name, segs in by_name.items():
        segs.sort(key=lambda s: -s["length"])
        used_mid = []
        count = 0
        for seg in segs:
            if count >= 2:
                break
            coords = seg["coords"]
            mid_idx = len(coords) // 2
            mx, my = coords[mid_idx]
            if any(math.hypot(mx - ux, my - uy) < 220 for ux, uy in used_mid):
                continue
            i0 = max(0, mid_idx - 1); i1 = min(len(coords) - 1, mid_idx + 1)
            dx = coords[i1][0] - coords[i0][0]; dy = coords[i1][1] - coords[i0][1]
            angle = math.degrees(math.atan2(dy, dx))
            if angle > 90: angle -= 180
            if angle < -90: angle += 180
            if not (xmin < mx < xmax and ymin < my < ymax):
                continue
            ax.text(mx, my, name.upper(), fontsize=road_label_fs, rotation=angle, ha="center", va="center",
                    color=ROAD_LABEL, zorder=6, family="sans-serif", weight="medium",
                    path_effects=[pe.withStroke(linewidth=2.6, foreground=ROAD_LABEL_HALO)])
            used_mid.append((mx, my))
            count += 1

    # ---- building labels, freshly placed against current (possibly-overridden) names ----
    placed = place_labels(buildings, overrides, xmin, xmax, ymin, ymax)
    for p in placed:
        txt = "\n".join(p["lines"])
        t = ax.text(p["x"], p["y"], txt, fontsize=p["fontsize"], ha="center", va="center",
                    color=LABEL_TEXT, weight="bold", zorder=8,
                    family="sans-serif", linespacing=1.05)
        t.set_path_effects([pe.withStroke(linewidth=2.6, foreground=LABEL_HALO)])
        if p["leader"]:
            ax.plot([p["cx"], p["x"]], [p["cy"], p["y"]], color=NAVY, linewidth=0.5, zorder=7)
            ax.plot([p["cx"]], [p["cy"]], marker="o", markersize=1.3, color=NAVY, zorder=7)

    # ---- neatline grid reference ----
    N_COLS, N_ROWS = 6, 7
    col_edges = [xmin + i * (xmax - xmin) / N_COLS for i in range(N_COLS + 1)]
    row_edges = [ymax - i * (ymax - ymin) / N_ROWS for i in range(N_ROWS + 1)]

    ax_left, ax_bottom, ax_w, ax_h = ax.get_position().bounds
    for i in range(N_COLS):
        xc = (col_edges[i] + col_edges[i + 1]) / 2
        fx = ax_left + (xc - xmin) / (xmax - xmin) * ax_w
        fig.text(fx, ax_bottom + ax_h + 0.012, str(i + 1), fontsize=8, family="sans-serif", weight="bold",
                  color="white", ha="center", va="bottom", zorder=35)
        fig.text(fx, ax_bottom - 0.012, str(i + 1), fontsize=8, family="sans-serif", weight="bold",
                  color="white", ha="center", va="top", zorder=35)
    for i in range(N_ROWS):
        yc = (row_edges[i] + row_edges[i + 1]) / 2
        fy = ax_bottom + (yc - ymin) / (ymax - ymin) * ax_h
        letter = string.ascii_uppercase[i]
        fig.text(ax_left - 0.010, fy, letter, fontsize=8, family="sans-serif", weight="bold",
                  color="white", ha="right", va="center", zorder=35)
        fig.text(ax_left + ax_w + 0.010, fy, letter, fontsize=8, family="sans-serif", weight="bold",
                  color="white", ha="left", va="center", zorder=35)

    ax.add_patch(Rectangle((xmin, ymin), xmax - xmin, ymax - ymin, facecolor="none",
                            edgecolor=NAVY, linewidth=1.6, zorder=30))

    # ---- brand sidebar ----
    SIDEBAR_GAP = 0.008
    PX0 = ax_left + ax_w + SIDEBAR_GAP
    PW = (1 - MARGIN_R) - PX0
    PY0, PH = ax_bottom, ax_h
    panel_ax = fig.add_axes([PX0, PY0, PW, PH], zorder=40)
    panel_ax.set_xlim(0, 1); panel_ax.set_ylim(0, 1)
    panel_ax.axis("off")
    panel_ax.add_patch(Rectangle((0, 0), 1, 1, transform=panel_ax.transAxes,
                                  facecolor="white", edgecolor=NAVY, linewidth=1.4, zorder=1))

    logo_img = mpimg.imread(DATA_DIR / "colliers-logo.png")
    logo_aspect = logo_img.shape[1] / logo_img.shape[0]
    LOGO_MARGIN = 0.06
    logo_w_fig = PW * (1 - 2 * LOGO_MARGIN)
    logo_h_fig = (logo_w_fig * fig_w_in) / logo_aspect / fig_h_in
    logo_left = PX0 + PW * LOGO_MARGIN
    logo_top_gap = 0.010
    logo_bottom = PY0 + PH - logo_top_gap - logo_h_fig
    logo_ax = fig.add_axes([logo_left, logo_bottom, logo_w_fig, logo_h_fig], zorder=41)
    logo_ax.imshow(logo_img)
    logo_ax.axis("off")

    logo_bottom_frac = (logo_bottom - PY0) / PH

    panel_ax.text(0.5, logo_bottom_frac - 0.045, "CHRISTCHURCH", fontsize=10.5, weight="black", family="sans-serif",
                  color=NAVY_DARK, ha="center", va="center", transform=panel_ax.transAxes, zorder=3)
    panel_ax.text(0.5, logo_bottom_frac - 0.070, "CENTRAL CITY", fontsize=8, weight="bold", family="sans-serif",
                  color=NAVY, ha="center", va="center", transform=panel_ax.transAxes, zorder=3)
    panel_ax.text(0.5, logo_bottom_frac - 0.093, "BUILDING & STREET MAP", fontsize=6, weight="bold", family="sans-serif",
                  color="#555", ha="center", va="center", transform=panel_ax.transAxes, zorder=3)

    panel_ax.plot([0.06, 0.94], [logo_bottom_frac - 0.119, logo_bottom_frac - 0.119], color=NAVY, linewidth=0.8,
                  transform=panel_ax.transAxes, zorder=3)
    panel_ax.text(0.5, logo_bottom_frac - 0.139, "LAND USE KEY", fontsize=6.4, weight="bold", family="sans-serif",
                  color=NAVY, ha="center", va="center", transform=panel_ax.transAxes, zorder=3)

    legend_items = [
        "Commercial", "Retailing Activity", "Apartments / Residential", "Hotels / Serviced Apts",
        "Bars", "Industrial", "Clubs / Sport / Govt", "Development / Vacant Sites",
        "Parks / Gardens", "Parking",
    ]
    name_to_color = dict(LU)
    name_to_color["Parks / Gardens"] = (PARK_FILL, PARK_EDGE)

    def sw_color(label):
        key_map = {
            "Commercial": "Commercial", "Retailing Activity": "Retail",
            "Apartments / Residential": "Apartments", "Hotels / Serviced Apts": "Hotels",
            "Bars": "Bars", "Development / Vacant Sites": "Development", "Parks / Gardens": "Parks / Gardens",
            "Parking": "Parking", "Industrial": "Industrial", "Clubs / Sport / Govt": "Clubs",
        }
        k = key_map[label]
        return name_to_color.get(k, LU.get(k))

    top_y = logo_bottom_frac - 0.164
    dy = 0.052
    for i, label in enumerate(legend_items):
        fc, ec = sw_color(label)
        y = top_y - i * dy
        panel_ax.add_patch(Rectangle((0.07, y - 0.014), 0.13, 0.028, transform=panel_ax.transAxes,
                                      facecolor=fc, edgecolor=ec, linewidth=0.6, zorder=3))
        panel_ax.text(0.235, y, label, fontsize=5.6, family="sans-serif", color="#222",
                      ha="left", va="center", transform=panel_ax.transAxes, zorder=3, wrap=True)

    panel_ax.plot([0.06, 0.94], [0.205, 0.205], color=NAVY, linewidth=0.8, transform=panel_ax.transAxes, zorder=3)
    panel_ax.text(0.5, 0.165, "Grid reference", fontsize=5.6, weight="bold", family="sans-serif",
                  color=NAVY, ha="center", va="center", transform=panel_ax.transAxes, zorder=3)
    panel_ax.text(0.5, 0.140, f"Columns 1–{N_COLS}, rows A–{string.ascii_uppercase[N_ROWS - 1]}\nread from map margins",
                  fontsize=4.8, family="sans-serif", color="#666", ha="center", va="center",
                  transform=panel_ax.transAxes, zorder=3, linespacing=1.4)

    panel_ax.plot([0.06, 0.94], [0.055, 0.055], color=NAVY, linewidth=0.8, transform=panel_ax.transAxes, zorder=3)
    panel_ax.text(0.5, 0.030, "Prepared for Colliers International\nNew Zealand", fontsize=4.6, style="italic",
                  family="sans-serif", color="#555", ha="center", va="center", transform=panel_ax.transAxes,
                  zorder=3, linespacing=1.4)

    # ---- footer band ----
    fig.add_artist(Rectangle((0, 0), 1, MARGIN_BOTTOM, transform=fig.transFigure, facecolor=NAVY,
                              edgecolor="none", zorder=20))
    for i, c in enumerate([GOLD, CYAN, RED]):
        fig.add_artist(Rectangle((0, MARGIN_BOTTOM - 0.006 - i * 0.006), 1, 0.005, transform=fig.transFigure,
                                  facecolor=c, edgecolor="none", zorder=21))

    fig.text(MARGIN_L, 0.038, "CHRISTCHURCH CBD — BUILDING & STREET REFERENCE MAP", fontsize=9, weight="bold",
             family="sans-serif", color="white", ha="left", va="center", zorder=22)
    fig.text(MARGIN_L, 0.020, "Map data © OpenStreetMap contributors, ODbL 1.0 (openstreetmap.org/copyright)  ·  "
             "NZTM2000 projection (EPSG:2193)  ·  Land-use categories inferred from OSM tags for illustrative purposes",
             fontsize=5.8, family="sans-serif", color="#cfe3f0", ha="left", va="center", zorder=22)

    # Regenerated on demand, so the footer date reflects the day it was printed
    # rather than being frozen at whenever the original PDF was first built.
    month_year = datetime.date.today().strftime("%B %Y")
    fig.text(1 - MARGIN_R, 0.029, month_year, fontsize=7.5, family="sans-serif",
             color="white", weight="bold", ha="right", va="center", zorder=22)

    na_ax = fig.add_axes([0.60, 0.010, 0.026, 0.040], zorder=22)
    na_ax.axis("off"); na_ax.patch.set_alpha(0)
    na_ax.set_xlim(0, 1); na_ax.set_ylim(0, 1)
    na_ax.annotate("", xy=(0.5, 1.0), xytext=(0.5, 0.30),
                   arrowprops=dict(arrowstyle="-|>", color="white", linewidth=1.6, mutation_scale=10))
    na_ax.text(0.5, 0.06, "N", fontsize=7, weight="black", family="sans-serif", ha="center", va="bottom", color="white")

    scale_ax = fig.add_axes([0.655, 0.016, 0.19, 0.020], zorder=22)
    scale_ax.axis("off"); scale_ax.patch.set_alpha(0)
    bar_m = 200
    data_width = xmax - xmin
    frac = bar_m / data_width
    n_segs = 4
    seg_frac = frac / n_segs
    y0 = 0.5
    for i in range(n_segs):
        color = "white" if i % 2 == 0 else NAVY
        scale_ax.add_patch(Rectangle((i * seg_frac, y0), seg_frac, 0.35, facecolor=color, edgecolor="white",
                                      linewidth=0.7, transform=scale_ax.transAxes))
    scale_ax.text(0, y0 + 0.5, "0", fontsize=5.5, family="sans-serif", ha="center", va="bottom", color="white", transform=scale_ax.transAxes)
    scale_ax.text(frac, y0 + 0.5, f"{bar_m} m", fontsize=5.5, family="sans-serif", ha="center", va="bottom", color="white", transform=scale_ax.transAxes)
    scale_ax.set_xlim(0, 1); scale_ax.set_ylim(0, 1)

    return fig


# ================= Page 2: full-bleed satellite view, same page size, no live data =================
# Static aerial photo (Esri World Imagery) pre-fetched once and bundled as
# _map_data/satellite-base.png, so this page needs no network access at
# request time. Same A3 page setup, footer and grid reference as page 1;
# logo sits in a tight keyline badge (no sidebar/legend -- doesn't apply to
# a photo). See Jason's brief: "Keep the footer, keep the logo, removed the
# sidebar" then "reduce the white box around the logo to a 1px keyline".
SAT_XMIN, SAT_XMAX = 1569899.25, 1571575.04
SAT_YMIN, SAT_YMAX = 5179593.85, 5180710.31


def build_satellite_figure():
    A3_W_MM, A3_H_MM = 420, 297
    DPI = 300
    fig_w_in, fig_h_in = A3_W_MM / 25.4, A3_H_MM / 25.4
    fig = plt.figure(figsize=(fig_w_in, fig_h_in), dpi=DPI)
    fig.patch.set_facecolor(NAVY)

    MARGIN_TOP = 0.028
    MARGIN_BOTTOM = 0.075
    MARGIN_L = 0.024
    MARGIN_R = 0.024
    ax = fig.add_axes([MARGIN_L, MARGIN_BOTTOM, 1 - MARGIN_L - MARGIN_R, 1 - MARGIN_TOP - MARGIN_BOTTOM])

    xmin, xmax, ymin, ymax = SAT_XMIN, SAT_XMAX, SAT_YMIN, SAT_YMAX
    ax.set_xlim(xmin, xmax); ax.set_ylim(ymin, ymax)
    ax.set_aspect("equal"); ax.axis("off")

    sat_img = mpimg.imread(DATA_DIR / "satellite-base.png")
    ax.imshow(sat_img, extent=(xmin, xmax, ymin, ymax), origin="upper", zorder=1)

    # ---- neatline grid reference (same as page 1) ----
    N_COLS, N_ROWS = 6, 7
    col_edges = [xmin + i * (xmax - xmin) / N_COLS for i in range(N_COLS + 1)]
    row_edges = [ymax - i * (ymax - ymin) / N_ROWS for i in range(N_ROWS + 1)]

    ax_left, ax_bottom, ax_w, ax_h = ax.get_position().bounds
    for i in range(N_COLS):
        xc = (col_edges[i] + col_edges[i + 1]) / 2
        fx = ax_left + (xc - xmin) / (xmax - xmin) * ax_w
        fig.text(fx, ax_bottom + ax_h + 0.012, str(i + 1), fontsize=8, family="sans-serif", weight="bold",
                  color="white", ha="center", va="bottom", zorder=35)
        fig.text(fx, ax_bottom - 0.012, str(i + 1), fontsize=8, family="sans-serif", weight="bold",
                  color="white", ha="center", va="top", zorder=35)
    for i in range(N_ROWS):
        yc = (row_edges[i] + row_edges[i + 1]) / 2
        fy = ax_bottom + (yc - ymin) / (ymax - ymin) * ax_h
        letter = string.ascii_uppercase[i]
        fig.text(ax_left - 0.010, fy, letter, fontsize=8, family="sans-serif", weight="bold",
                  color="white", ha="right", va="center", zorder=35)
        fig.text(ax_left + ax_w + 0.010, fy, letter, fontsize=8, family="sans-serif", weight="bold",
                  color="white", ha="left", va="center", zorder=35)

    ax.add_patch(Rectangle((xmin, ymin), xmax - xmin, ymax - ymin, facecolor="none",
                            edgecolor=NAVY, linewidth=1.6, zorder=30))

    # ---- logo badge: tight white keyline around the logo, caption below on the photo ----
    logo_img = mpimg.imread(DATA_DIR / "colliers-logo.png")
    logo_aspect = logo_img.shape[1] / logo_img.shape[0]

    BADGE_W = 0.150
    BADGE_PAD = 0.010
    badge_left = ax_left + ax_w - BADGE_PAD - BADGE_W
    badge_top = ax_bottom + ax_h - BADGE_PAD

    logo_margin_frac = 0.025
    logo_w_fig = BADGE_W * (1 - 2 * logo_margin_frac)
    logo_h_fig = (logo_w_fig * fig_w_in) / logo_aspect / fig_h_in
    badge_h = logo_h_fig / (1 - 2 * logo_margin_frac)

    badge_ax = fig.add_axes([badge_left, badge_top - badge_h, BADGE_W, badge_h], zorder=40)
    badge_ax.set_xlim(0, 1); badge_ax.set_ylim(0, 1); badge_ax.axis("off")
    badge_ax.add_patch(Rectangle((0, 0), 1, 1, transform=badge_ax.transAxes,
                                  facecolor="white", edgecolor="white", linewidth=0.75, zorder=1))

    logo_left_fig = badge_left + BADGE_W * logo_margin_frac
    logo_bottom_fig = badge_top - badge_h + badge_h * logo_margin_frac
    logo_ax = fig.add_axes([logo_left_fig, logo_bottom_fig, logo_w_fig, logo_h_fig], zorder=41)
    logo_ax.imshow(logo_img)
    logo_ax.axis("off")

    fig.text(badge_left + BADGE_W / 2, badge_top - badge_h - 0.012, "CENTRAL CITY — AERIAL VIEW",
              fontsize=4.6, weight="bold", family="sans-serif", color="white", ha="center", va="top", zorder=41,
              path_effects=[pe.withStroke(linewidth=2.0, foreground=NAVY_DARK)])

    # ---- footer band (identical structure to page 1) ----
    fig.add_artist(Rectangle((0, 0), 1, MARGIN_BOTTOM, transform=fig.transFigure, facecolor=NAVY,
                              edgecolor="none", zorder=20))
    for i, c in enumerate([GOLD, CYAN, RED]):
        fig.add_artist(Rectangle((0, MARGIN_BOTTOM - 0.006 - i * 0.006), 1, 0.005, transform=fig.transFigure,
                                  facecolor=c, edgecolor="none", zorder=21))

    fig.text(MARGIN_L, 0.038, "CHRISTCHURCH CBD — AERIAL / SATELLITE VIEW", fontsize=9, weight="bold",
             family="sans-serif", color="white", ha="left", va="center", zorder=22)
    fig.text(MARGIN_L, 0.020, "Imagery © Esri, Maxar, Earthstar Geographics and the GIS User Community  ·  "
             "NZTM2000 projection (EPSG:2193)  ·  For reference only — not survey-accurate",
             fontsize=5.8, family="sans-serif", color="#cfe3f0", ha="left", va="center", zorder=22)

    month_year = datetime.date.today().strftime("%B %Y")
    fig.text(1 - MARGIN_R, 0.029, month_year, fontsize=7.5, family="sans-serif",
             color="white", weight="bold", ha="right", va="center", zorder=22)

    na_ax = fig.add_axes([0.60, 0.010, 0.026, 0.040], zorder=22)
    na_ax.axis("off"); na_ax.patch.set_alpha(0)
    na_ax.set_xlim(0, 1); na_ax.set_ylim(0, 1)
    na_ax.annotate("", xy=(0.5, 1.0), xytext=(0.5, 0.30),
                   arrowprops=dict(arrowstyle="-|>", color="white", linewidth=1.6, mutation_scale=10))
    na_ax.text(0.5, 0.06, "N", fontsize=7, weight="black", family="sans-serif", ha="center", va="bottom", color="white")

    scale_ax = fig.add_axes([0.655, 0.016, 0.19, 0.020], zorder=22)
    scale_ax.axis("off"); scale_ax.patch.set_alpha(0)
    bar_m = 200
    data_width = xmax - xmin
    frac = bar_m / data_width
    n_segs = 4
    seg_frac = frac / n_segs
    y0 = 0.5
    for i in range(n_segs):
        color = "white" if i % 2 == 0 else NAVY
        scale_ax.add_patch(Rectangle((i * seg_frac, y0), seg_frac, 0.35, facecolor=color, edgecolor="white",
                                      linewidth=0.7, transform=scale_ax.transAxes))
    scale_ax.text(0, y0 + 0.5, "0", fontsize=5.5, family="sans-serif", ha="center", va="bottom", color="white", transform=scale_ax.transAxes)
    scale_ax.text(frac, y0 + 0.5, f"{bar_m} m", fontsize=5.5, family="sans-serif", ha="center", va="bottom", color="white", transform=scale_ax.transAxes)
    scale_ax.set_xlim(0, 1); scale_ax.set_ylim(0, 1)

    return fig


# ================= Combine both pages into one PDF =================
def render_full_pdf():
    overrides = fetch_overrides()

    buf = BytesIO()
    with PdfPages(buf) as pdf:
        map_fig = build_map_figure(overrides)
        pdf.savefig(map_fig, facecolor=NAVY)
        plt.close(map_fig)

        sat_fig = build_satellite_figure()
        pdf.savefig(sat_fig, facecolor=NAVY)
        plt.close(sat_fig)

    buf.seek(0)
    return buf.read()


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            pdf_bytes = render_full_pdf()
        except Exception as exc:
            self.send_response(500)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(("Failed to render map: " + str(exc) + "\n\n" + traceback.format_exc()).encode("utf-8"))
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Disposition", 'inline; filename="christchurch-cbd-map-a3.pdf"')
        self.send_header("Content-Length", str(len(pdf_bytes)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(pdf_bytes)
