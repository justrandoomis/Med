import { useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { ThemeProvider, ToastProvider } from '../design';
import { createAppRouter } from './router';

export function App() {
  const [router] = useState(createAppRouter);
  return (
    <ThemeProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ThemeProvider>
  );
}
