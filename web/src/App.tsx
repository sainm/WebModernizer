import { Suspense, lazy, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api';
import { AppShell } from './components/AppShell';
import { Loading } from './components/ui';
import Overview from './pages/Overview';
import Projects from './pages/Projects';
import ProjectDetail from './pages/ProjectDetail';
import Scans from './pages/Scans';
import ScanDetail from './pages/ScanDetail';
import Rules from './pages/Rules';
import Settings from './pages/Settings';
import Reports from './pages/Reports';

// Monaco and the graph library are heavy; they load only when the page needs them.
const Findings = lazy(() => import('./pages/Findings'));
const Dependency = lazy(() => import('./pages/Dependency'));
const Migration = lazy(() => import('./pages/Migration'));

export default function App() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    api
      .health()
      .then((payload) => setVersion(payload.version))
      .catch(() => setVersion(null));
  }, []);

  return (
    <AppShell version={version}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/scans" element={<Scans />} />
          <Route path="/scans/:scanId" element={<ScanDetail />} />
          <Route path="/findings" element={<Findings />} />
          <Route path="/scans/:scanId/findings" element={<Findings />} />
          <Route path="/dependencies" element={<Dependency />} />
          <Route path="/scans/:scanId/dependencies" element={<Dependency />} />
          <Route path="/migration" element={<Migration />} />
          <Route path="/scans/:scanId/migration" element={<Migration />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
