import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import logoDark from "@corelink/ui/assets/logo-lockup-dark.svg";
import MerchantsPage from "./pages/MerchantsPage";
import InfraPage from "./pages/InfraPage";
import NodesPage from "./pages/NodesPage";
import MonitoringPage from "./pages/MonitoringPage";
import SubscribersPage from "./pages/SubscribersPage";
import SupportPage from "./pages/SupportPage";
import SalesPage from "./pages/SalesPage";
import BroadcastsPage from "./pages/BroadcastsPage";
import PlansPage from "./pages/PlansPage";
import TrafficPage from "./pages/TrafficPage";
import AccessPage from "./pages/AccessPage";
import ProfilePage from "./pages/ProfilePage";
import AuthGate from "./components/AuthGate";
import { roleAtLeast, useSession } from "./session";
import { ROLE_LABELS, type AdminRole } from "./api";

/**
 * Экраны и минимальная роль для каждого. Это только навигация: закрывает раздел
 * гвард в core, здесь мы лишь не показываем то, что всё равно ответит 403.
 */
const NAV: { to: string; label: string; role: AdminRole; element: JSX.Element }[] = [
  { to: "/support", label: "Поддержка", role: "support", element: <SupportPage /> },
  { to: "/subscribers", label: "Подписчики", role: "support", element: <SubscribersPage /> },
  { to: "/merchants", label: "Мерчанты", role: "superadmin", element: <MerchantsPage /> },
  { to: "/infra", label: "Инфраструктура", role: "admin", element: <InfraPage /> },
  { to: "/nodes", label: "Ноды и каскады", role: "admin", element: <NodesPage /> },
  { to: "/monitoring", label: "Мониторинг", role: "support", element: <MonitoringPage /> },
  { to: "/traffic", label: "Трафик", role: "admin", element: <TrafficPage /> },
  { to: "/sales", label: "Продажи", role: "admin", element: <SalesPage /> },
  { to: "/broadcasts", label: "Рассылки", role: "admin", element: <BroadcastsPage /> },
  { to: "/plans", label: "Тарифы", role: "admin", element: <PlansPage /> },
  { to: "/access", label: "Доступ", role: "admin", element: <AccessPage /> },
  { to: "/profile", label: "Мой профиль", role: "support", element: <ProfilePage /> },
];

export default function App() {
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  );
}

function Shell() {
  const { me, signOut } = useSession();
  // «Мой профиль» открыт самой младшей роли, поэтому список пуст быть не может.
  const allowed = NAV.filter((item) => roleAtLeast(me.role, item.role));
  const home = allowed[0].to;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <img src={logoDark} alt="CoreLink" />
        </div>
        <nav>
          {allowed.map((item) => (
            <NavLink key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-user">
          <div className="small">{me.displayName ?? me.email ?? "Оператор"}</div>
          <div className="muted small">{ROLE_LABELS[me.role]}</div>
          <button type="button" className="btn btn-sm" onClick={signOut}>
            Выйти
          </button>
        </div>
      </aside>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to={home} replace />} />
          {allowed.map((item) => (
            <Route key={item.to} path={item.to} element={item.element} />
          ))}
          {/* Экран не по роли и несуществующий адрес ведут в одно место: своих прав
              оператор не знает, и «страница есть, но не для вас» ему ничего не даёт. */}
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
}
