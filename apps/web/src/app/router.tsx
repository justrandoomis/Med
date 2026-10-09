import { createBrowserRouter } from 'react-router-dom';
import { buildRoutes } from './routes';

export function createAppRouter() {
  return createBrowserRouter(buildRoutes());
}
