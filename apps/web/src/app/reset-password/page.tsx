import { InfoPage } from '../../components/InfoPage';
export default function ResetPasswordPage() {
  return (
    <InfoPage eyebrow="Account recovery" title="Complete password reset">
      <p>
        Use the single-use recovery link issued by the identity provider. Existing sessions and
        withdrawal eligibility may be restricted after a reset.
      </p>
    </InfoPage>
  );
}
