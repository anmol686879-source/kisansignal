#!/usr/bin/env python3
"""Rebuild the SoilSCAPE sensor data used by the Sensors tab.

Usage:
  pip install netCDF4 numpy
  python scripts/build_soilscape.py path/to/SoilSCAPE_zip_or_folder [--inject]

Reads soil_moist_daily_*.nc, writes scripts/soilscape.json and, with --inject,
replaces the `var SS=[...]` data block inside public/index.html.
"""
import sys, os, re, glob, json, zipfile, tempfile, datetime as dt
import numpy as np, netCDF4 as nc

BASE = dt.datetime(2011, 1, 1)

def build(folder):
    out = []
    for f in sorted(glob.glob(os.path.join(folder, '**', 'soil_moist_daily_*.nc'), recursive=True)):
        d = nc.Dataset(f); name = os.path.basename(f)[17:-3]
        t = np.array(d['time'][:]).astype(int)
        sm = np.ma.filled(d['soil_moisture'][:].astype(float), np.nan)  # pid,time,depth
        dep = np.array(d['depth'][:]).astype(float)
        T = sm.transpose(1, 0, 2)
        def band(lo, hi):
            m = (dep > lo) & (dep <= hi) if lo else (dep <= hi)
            with np.errstate(all='ignore'):
                return np.nanmean(T[:, :, m].reshape(T.shape[0], -1), axis=1)
        with np.errstate(all='ignore'):
            allm = np.nanmean(T.reshape(T.shape[0], -1), axis=1)
        ser = np.vstack([band(0, 10), band(10, 30), band(30, 999), allm])
        step = 1 if (t[-1] - t[0]) < 120 else 7
        k0, k1 = t[0] // step, t[-1] // step
        W = []
        for k in range(k0, k1 + 1):
            idx = np.where((t // step) == k)[0]; row = []
            for b in range(4):
                v = ser[b, idx]; v = v[np.isfinite(v)]
                row.append(round(float(v.mean()), 1) if len(v) else None)
            W.append(row)
        dates = [BASE + dt.timedelta(days=int(x)) for x in t]
        mc = []
        for m in range(1, 13):
            v = [allm[i] for i, x in enumerate(dates) if x.month == m and np.isfinite(allm[i])]
            mc.append(round(float(np.mean(v)), 1) if len(v) > 5 else None)
        valid = allm[np.isfinite(allm)]
        out.append(dict(id=name, n=name.rsplit('_', 1)[0], st=name.rsplit('_', 1)[1],
            la=round(float(np.nanmean(d['lat'][:])), 3), lo=round(float(np.nanmean(d['lon'][:])), 3),
            np=int(d.dimensions['pid'].size), s=dates[0].strftime('%Y-%m-%d'), e=dates[-1].strftime('%Y-%m-%d'),
            dd=int(len(valid)), k0=int(k0 * step), sp=step, w=W, mc=mc,
            p=[round(float(np.percentile(valid, q)), 1) for q in (5, 25, 50, 75, 95)],
            dpt=sorted(set(int(x) for x in dep[np.isfinite(T).any(axis=(0, 1))]))))
    return out

if __name__ == '__main__':
    src = sys.argv[1]; tmp = None
    if src.endswith('.zip'):
        tmp = tempfile.mkdtemp()
        with zipfile.ZipFile(src) as z:
            z.extractall(tmp, [n for n in z.namelist() if 'soil_moist_daily_' in n and n.endswith('.nc')])
        src = tmp
    data = build(src)
    js = json.dumps(data, separators=(',', ':'))
    here = os.path.dirname(os.path.abspath(__file__))
    open(os.path.join(here, 'soilscape.json'), 'w').write(js)
    print(f'{len(data)} sites, {len(js)//1024} KB')
    if '--inject' in sys.argv:
        p = os.path.join(here, '..', 'public', 'index.html')
        h = open(p, encoding='utf-8').read()
        h, n = re.subn(r'var SS=\[.*?\];\nvar ssi=', lambda m: 'var SS=' + js + ';\nvar ssi=', h, flags=re.S)
        assert n == 1, 'SS block not found'
        open(p, 'w', encoding='utf-8').write(h); print('injected into public/index.html')
