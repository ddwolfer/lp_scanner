import { NavLink, Route, Routes } from 'react-router-dom'
import { useEffect, useState } from 'react'
const BUILD = new Date(__BUILD_TIME__).toISOString().slice(0, 16).replace('T', ' ')
import Overview from './pages/Overview'
import Pool from './pages/Pool'
import Positions from './pages/Positions'
export default function App() {
  const [w, setW] = useState(window.innerWidth); useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  return <>
    <header className="top">
      <span className="brand">LP Scanner<small>Robinhood Chain · 股票代幣 × USDG</small></span>
      <nav>
        <NavLink to="/" end>總覽</NavLink>
        <NavLink to="/positions">我的頭寸</NavLink>
      </nav>
      <span className="right" title="版本時間 · 目前視窗 CSS 寬度（縮放後）">build {BUILD} · {w}px</span>
    </header>
    <main>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/pool/:id" element={<Pool />} />
        <Route path="/positions" element={<Positions />} />
      </Routes>
    </main>
  </>
}
