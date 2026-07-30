import { InfoPage } from '../../components/InfoPage';
export default function VerifyEmailPage() {
  return (
    <InfoPage eyebrow="Account verification" title="Verify your email">
      <p>
        Open the verification link sent by the configured identity provider. This page updates after
        a verified session is established.
      </p>
    </InfoPage>
  );
}
