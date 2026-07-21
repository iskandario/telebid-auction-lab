import { ExperimentDashboard } from './ExperimentDashboard';
import { TelegramMiniApp } from './TelegramMiniApp';

export function App() {
  const mode = new URLSearchParams(window.location.search).get('mode');
  if (mode === 'lab') return <ExperimentDashboard />;
  return <TelegramMiniApp />;
}
