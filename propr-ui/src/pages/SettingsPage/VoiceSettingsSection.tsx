import { useState } from 'react';
import { isDesktopRuntime } from '../../config/runtimeMode';
import { useVoicePreference } from '../../hooks/useVoicePreference';

export default function VoiceSettingsSection() {
  const preference = useVoicePreference();
  const [error, setError] = useState<{ key: string | null; message: string } | null>(null);
  return (
    <section aria-labelledby="voice-settings-heading">
      <h4 id="voice-settings-heading" className="mb-4 text-[10px] font-bold uppercase tracking-wider text-gray-500">
        Voice briefings · Experimental
      </h4>
      <label className="flex items-center justify-between gap-4 rounded-md border border-gray-200 bg-gray-50 p-3">
        <span className="text-xs font-medium text-gray-700">Enable voice briefings</span>
        <input
          type="checkbox"
          checked={preference.enabled}
          disabled={!preference.available}
          aria-describedby="voice-settings-explanation"
          className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500"
          onChange={event => {
            setError(null);
            try { preference.setEnabled(event.target.checked); } catch {
              setError({ key: preference.key, message: 'Could not save this preference. Voice is off for this session. Try disabling it again before reloading.' });
            }
          }}
        />
      </label>
      <p id="voice-settings-explanation" className="mt-3 text-xs leading-5 text-gray-500">
        Off by default in every runtime. Saved for this account and instance on this device; other
        devices, browsers, and accounts keep their own choice. Enables on-demand briefings and, where
        the runtime supports it, one short spoken command.
        {isDesktopRuntime()
          ? ' Microphone access does not enable speech recognition in this desktop runtime; use text briefings or voice commands in a supported browser.'
          : ' Microphone access is requested only after you acknowledge the vendor-processing notice and select Listen.'}
        {' '}Turning this off stops voice activity and hides its controls. Enabling it does not request
        microphone access or start audio.
      </p>
      {!preference.available && (
        <p className="mt-3 text-xs leading-5 text-gray-500">
          Sign in to this instance to choose this preference.
        </p>
      )}
      {error && error.key === preference.key && <p role="alert" className="mt-3 text-xs text-red-600">{error.message}</p>}
    </section>
  );
}
