import { render, screen } from '@testing-library/react';
import App from './App';

test('renders login screen by default when unauthenticated', async () => {
  render(<App />);
  const heading = await screen.findByRole('heading', { name: /login/i });
  expect(heading).toBeInTheDocument();
});
