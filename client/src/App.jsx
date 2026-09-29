import ConsolePage from './pages/ConsolePage.jsx';
import DisplayPage from './pages/DisplayPage.jsx';
import HomePage from './pages/HomePage.jsx';

// 极简路径路由：/console 控制台，/display 投屏
export default function App() {
  const p = location.pathname.replace(/\/+$/, '');
  if (p === '/console') return <ConsolePage />;
  if (p === '/display') return <DisplayPage />;
  return <HomePage />;
}
