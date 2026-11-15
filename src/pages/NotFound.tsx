import { Link } from 'react-router-dom';

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-semibold text-brand-600">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 text-sm text-slate-500">The page you are looking for doesn't exist or has moved.</p>
      <div className="mt-6 flex gap-2">
        <Link to="/" className="btn-secondary">Home</Link>
        <Link to="/app" className="btn-primary">Go to dashboard</Link>
      </div>
    </div>
  );
}
