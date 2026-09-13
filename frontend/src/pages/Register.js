import React from 'react';
import { Link } from 'react-router-dom';
import Card from '../components/ui/Card';

export default function Register() {
  return (
    <div className="max-w-md mx-auto">
      <Card className="p-6">
        <h2 className="text-2xl font-semibold text-slate-900 dark:text-white mb-4">Owner-only access</h2>
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Public registration is disabled. This paper-trading application is reserved for its configured owner.
          Access is configured by the operator.
        </p>
        <p className="mt-4 text-sm text-slate-500">
          If you are the configured owner,{' '}
          <Link to="/login" className="text-slate-900 dark:text-white underline">log in</Link>
          {' '}with your existing credentials.
        </p>
      </Card>
    </div>
  );
}
