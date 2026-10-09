import type { FeatureRoutes } from '../../app/routeTypes';
import { loginLoader, recoverLoader, setupLoader } from '../../app/guards';
import { SetupScreen } from './SetupScreen';
import { LoginScreen } from './LoginScreen';
import { RecoverScreen } from './RecoverScreen';

export const routes: FeatureRoutes = {
  public: [
    { path: 'setup', loader: setupLoader, element: <SetupScreen /> },
    { path: 'login', loader: loginLoader, element: <LoginScreen /> },
    { path: 'recover', loader: recoverLoader, element: <RecoverScreen /> },
  ],
};
