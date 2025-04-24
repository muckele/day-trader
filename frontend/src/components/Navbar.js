import { Link } from 'react-router-dom';

export default function Navbar() {
  return (
    <nav style={{
      display: 'flex',
      gap: 20,
      padding: '10px 20px',
      borderBottom: '1px solid #ddd'
    }}>
      <Link to="/" style={{ textDecoration: 'none', fontWeight: 'bold' }}>
        Day Trader
      </Link>
    </nav>
  );
}
