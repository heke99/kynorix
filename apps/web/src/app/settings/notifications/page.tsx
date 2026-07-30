'use client';

import { useEffect, useState } from 'react';
import { kynorixApi } from '../../../lib/api';

type Preferences = Awaited<ReturnType<typeof kynorixApi.notificationPreferences>>;

export default function NotificationsPage() {
  const [preferences, setPreferences] = useState<Preferences>();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    void kynorixApi
      .notificationPreferences()
      .then(setPreferences)
      .catch((cause: unknown) => {
        setNotice(cause instanceof Error ? cause.message : 'Preferences could not be loaded.');
      });
  }, []);
  async function save() {
    if (!preferences) return;
    try {
      await kynorixApi.updateNotificationPreferences(preferences);
      setNotice('Notification preferences saved.');
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Preferences could not be saved.');
    }
  }
  return (
    <div className="form-page">
      <div className="page-heading">
        <span className="kicker">Communication preferences</span>
        <h1>Notifications</h1>
        <p>Mandatory security notices remain enabled independently of these choices.</p>
      </div>
      <section className="form-card">
        {preferences &&
          (
            [
              ['emailEnabled', 'Email'],
              ['pushEnabled', 'Push'],
              ['inAppEnabled', 'In-app'],
              ['securitySmsEnabled', 'Security SMS'],
              ['marketClosingEnabled', 'Market closing reminders'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              <input
                type="checkbox"
                checked={preferences[key]}
                onChange={(event) =>
                  setPreferences({ ...preferences, [key]: event.target.checked })
                }
              />
              {label}
            </label>
          ))}
        <button className="primary-button" disabled={!preferences} onClick={() => void save()}>
          Save preferences
        </button>
        {notice && <div className="ticket-message">{notice}</div>}
      </section>
    </div>
  );
}
