import { InfoPage } from '../../components/InfoPage';
export default function ForgotPasswordPage() {
  return (
    <InfoPage eyebrow="Account recovery" title="Reset your password">
      <p>
        Password recovery is handled by the configured identity provider. Return to Log in and
        select the recovery option.
      </p>
    </InfoPage>
  );
}
