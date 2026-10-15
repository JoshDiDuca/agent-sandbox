import 'bootstrap/dist/css/bootstrap.min.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { followSystemTheme } from './theme';
import { ToastProvider } from './ui';
import './app.css';

followSystemTheme();
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  );
