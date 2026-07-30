import { kynorixApi } from '../../lib/api';
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>;
}) {
  const returnTo = (await searchParams).returnTo ?? '/';
  return (
    <div className="auth-page">
      <section className="form-card">
        <span className="kicker">Secure access</span>
        <h1>Log in to Kynorix</h1>
        <p>You will continue through the configured identity provider.</p>
        <a className="primary-button" href={kynorixApi.loginUrl(returnTo)}>
          Continue to log in
        </a>
      </section>
    </div>
  );
}
