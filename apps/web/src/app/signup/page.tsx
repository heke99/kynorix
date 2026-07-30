'use client';
import { zoryqonApi } from '../../lib/api';
export default function SignupPage() {
  return (
    <div className="auth-page">
      <section className="form-card">
        <span className="kicker">Create your account</span>
        <h1>Sign up</h1>
        <p>
          Email verification and identity checks are required before eligible products become
          available.
        </p>
        <a className="primary-button" href={zoryqonApi.loginUrl('/verification')}>
          Continue to sign up
        </a>
      </section>
    </div>
  );
}
