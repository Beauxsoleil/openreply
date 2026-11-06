"use client";

/**
 * ErrorState
 *
 * Shared fetch-failure panel: a short message plus a Retry button. Pages
 * render this instead of their empty/zero state when their API call fails,
 * so a dead API is never mistaken for "no data".
 */

import { useI18n } from "@/lib/i18n/provider";

interface ErrorStateProps {
  message?: string;
  onRetry: () => void;
}

export default function ErrorState({ message, onRetry }: ErrorStateProps) {
  const { t } = useI18n();
  return (
    <div
      role="alert"
      className="panel rounded p-6 text-center sm:p-8"
    >
      <p className="text-sm font-medium text-foreground">
        {message ?? t("Failed to load this page. Please try again.")}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-hover"
      >
        {t("Retry")}
      </button>
    </div>
  );
}
