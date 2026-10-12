import { NavLink, Route, Routes } from 'react-router-dom'
import { useEffect, useState } from 'react'
const BUILD = new Date(__BUILD_TIME__).toISOString().slice(0, 16).replace('T', ' ')
import Overview from './pages/Overview'
import Pool from './pages/Pool'
import Positions from './pages/Positions'
import Notes from './pages/Notes'
export default function App() {
  const [w, setW] = useState(window.innerWidth); useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])
  return <>
    <header className="top">
      <span className="brand">LP<span className="brand-rest"> Scanner</span><small>Robinhood Chain · 股票代幣 × USDG</small></span>
      <nav>
        <NavLink to="/" end>總覽</NavLink>
        <NavLink to="/positions">我的頭寸</NavLink>
        <NavLink to="/notes">備忘錄</NavLink>
      </nav>
      <span className="right" title="版本時間 · 目前視窗 CSS 寬度（縮放後）"><span className="build">build {BUILD} · </span>{w}px</span>
    </header>
    <main>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/pool/:id" element={<Pool />} />
        <Route path="/positions" element={<Positions />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="/notes/:name" element={<Notes />} />
      </Routes>
    </main>
  </>
}
