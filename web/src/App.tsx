import { NavLink, Route, Routes } from 'react-router-dom'
import Overview from './pages/Overview'
import Pool from './pages/Pool'
import Positions from './pages/Positions'
export default function App() {
  return <>
    <header className="top">
      <span className="brand">LP Scanner<small>Robinhood Chain · 股票代幣 × USDG</small></span>
      <nav>
        <NavLink to="/" end>總覽</NavLink>
        <NavLink to="/positions">我的頭寸</NavLink>
      </nav>
      <span className="right">唯讀 · 區網</span>
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
