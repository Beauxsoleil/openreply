"use client";

/**
 * DM Logs Page
 *
 * Filterable, paginated table of DM logs.
 */

import { useI18n } from "@/lib/i18n/provider";
import { useEffect, useState, useCallback, Fragment } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import ErrorState from "@/components/ui/error-state";
import StatusBadge from "@/components/status-badge";

interface DmLog {
  id: string;
  commenterId: string;
  commenterName: string | null;
  commentText: string;
  status: string;
  errorMessage: string | null;
  createdAt: string;
  automation: { name: string; keywords: string[] };
  instagramAccount: { username: string };
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const STATUS_FILTERS = [
  "ALL",
  "SENT",
  "FAILED",
  "PENDING",
  "SKIPPED_RATE_LIMIT",
  "SKIPPED_PLAN_LIMIT",
  "SKIPPED_DEDUP",
];

export default function LogsPage() {
  const { t, label, locale } = useI18n();
  const [logs, setLogs] = useState<DmLog[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("all");
  const [page, setPage] = useState(1);
  const [searchText, setSearchText] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // Which failed row's error message is expanded.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), limit: "20" });
      if (statusFilter !== "ALL") params.set("status", statusFilter);
      if (selectedAccountId !== "all") {
        params.set("instagramAccountId", selectedAccountId);
      }
      if (searchText.trim()) params.set("q", searchText.trim());
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);

      const res = await fetch(`/api/logs?${params}`);
      const data = await res.json();
      if (data.success) {
        setLogs(data.data.logs);
        setPagination(data.data.pagination);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch (err) {
      console.error("Failed to fetch logs:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, selectedAccountId, searchText, fromDate, toDate]);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((res) => res.json())
      .then((payload) => {
        if (payload.success) setAccounts(payload.data.instagramAccounts ?? []);
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchLogs();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fetchLogs]);

  function handleFilterChange(status: string) {
    setLoading(true);
    setStatusFilter(status);
    setPage(1);
  }

  function handleAccountChange(accountId: string) {
    setLoading(true);
    setSelectedAccountId(accountId);
    setPage(1);
  }

  function handleTextFilterChange(value: string) {
    setLoading(true);
    setSearchText(value);
    setPage(1);
  }

  function handleDateChange(
    which: "from" | "to",
    value: string
  ) {
    setLoading(true);
    if (which === "from") setFromDate(value);
    else setToDate(value);
    setPage(1);
  }

  function clearFilters() {
    setLoading(true);
    setSearchText("");
    setFromDate("");
    setToDate("");
    setStatusFilter("ALL");
    setPage(1);
  }

  // CSV export uses the same filters as the table (all matching rows).
  const exportParams = new URLSearchParams();
  if (statusFilter !== "ALL") exportParams.set("status", statusFilter);
  if (selectedAccountId !== "all") {
    exportParams.set("instagramAccountId", selectedAccountId);
  }
  if (searchText.trim()) exportParams.set("q", searchText.trim());
  if (fromDate) exportParams.set("from", fromDate);
  if (toDate) exportParams.set("to", toDate);
  exportParams.set("format", "csv");

  return (
    <div className="space-y-6">
      {/* Text + date filters and CSV export */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label htmlFor="logs-search" className="sr-only">
            {t("Search logs by comment or name…")}
          </label>
          <input
            id="logs-search"
            type="search"
            value={searchText}
            onChange={(e) => handleTextFilterChange(e.target.value)}
            placeholder={t("Search logs by comment or name…")}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="logs-from" className="block text-xs font-medium text-muted mb-1">
            {t("Start date")}
          </label>
          <input
            id="logs-from"
            type="date"
            value={fromDate}
            onChange={(e) => handleDateChange("from", e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="logs-to" className="block text-xs font-medium text-muted mb-1">
            {t("End date")}
          </label>
          <input
            id="logs-to"
            type="date"
            value={toDate}
            onChange={(e) => handleDateChange("to", e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none"
          />
        </div>
        {(searchText || fromDate || toDate || statusFilter !== "ALL") && (
          <button
            type="button"
            onClick={clearFilters}
            className="min-h-11 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground"
          >
            {t("Clear filters")}
          </button>
        )}
        <a
          href={`/api/logs?${exportParams}`}
          className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-foreground"
        >
          {t("Export CSV")}
        </a>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((status) => (
            <button
              key={status}
              onClick={() => handleFilterChange(status)}
              className={`
                px-3 py-1.5 min-h-11 rounded-lg text-xs font-medium transition-all
                ${
                  statusFilter === status
                    ? "bg-accent/15 text-accent border border-accent/20"
                    : "bg-surface text-muted border border-border hover:border-border-hover hover:text-foreground"
                }
              `}
            >
              {label(status)}
            </button>
          ))}
        </div>
        {accounts.length > 1 && (
          <AccountSelect
            accounts={accounts}
            value={selectedAccountId}
            onChange={handleAccountChange}
          />
        )}
      </div>

      {/* Load failure must not look like "no logs". */}
      {loadError && !loading && logs.length === 0 && (
        <ErrorState onRetry={() => { setLoading(true); void fetchLogs(); }} />
      )}

      {/* Table */}
      <div className="panel rounded overflow-hidden">
        {/* Six columns don't fit a phone; the table keeps its width and scrolls
            horizontally inside the panel rather than crushing every cell. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">{t("Commenter")}</th>
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">{t("Comment")}</th>
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">{t("Campaign")}</th>
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">{t("Account")}</th>
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">{t("Status")}</th>
                <th className="px-4 py-4 text-xs font-semibold text-muted uppercase tracking-wider sm:px-6">{t("Time")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading && (
                <>
                  {[...Array(5)].map((_, i) => (
                    <tr key={i}>
                      <td colSpan={6} className="px-4 py-4 sm:px-6">
                        <div className="h-4 bg-surface-hover rounded" />
                      </td>
                    </tr>
                  ))}
                </>
              )}
              {!loading && !loadError && logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-muted sm:px-6">
                    {t("No logs found")}
                  </td>
                </tr>
              )}
              {!loading &&
                logs.map((log) => (
                  <Fragment key={log.id}>
                    <tr className="hover:bg-surface-hover/50 transition-colors">
                      <td className="px-4 py-4 sm:px-6">
                        <span className="font-medium text-foreground">
                          @{log.commenterName ?? log.commenterId.slice(0, 8)}
                        </span>
                      </td>
                      <td className="px-4 py-4 max-w-[200px] sm:px-6">
                        <span className="text-muted truncate block">{log.commentText}</span>
                      </td>
                      <td className="px-4 py-4 sm:px-6">
                        <span className="text-muted">{log.automation.name}</span>
                      </td>
                      <td className="px-4 py-4 sm:px-6">
                        <span className="text-muted">@{log.instagramAccount.username}</span>
                      </td>
                      <td className="px-4 py-4 sm:px-6">
                        <StatusBadge status={log.status} />
                        {log.errorMessage && (
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedId((cur) =>
                                cur === log.id ? null : log.id
                              )
                            }
                            aria-expanded={expandedId === log.id}
                            className="mt-1 block min-h-11 text-xs font-medium text-error hover:underline"
                          >
                            {expandedId === log.id
                              ? t("Hide error")
                              : t("Show error")}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-4 text-muted whitespace-nowrap sm:px-6">
                        {new Date(log.createdAt).toLocaleString(locale, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                    </tr>
                    {expandedId === log.id && log.errorMessage && (
                      <tr>
                        <td
                          colSpan={6}
                          className="bg-error/5 px-4 py-3 text-xs text-error sm:px-6"
                        >
                          {log.errorMessage}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 border-t border-border sm:px-6">
            <p className="text-xs text-muted">
              {t("Showing {start}–{end} of {total}", {
                start: (pagination.page - 1) * pagination.limit + 1,
                end: Math.min(pagination.page * pagination.limit, pagination.total),
                total: pagination.total,
              })}
            </p>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => {
                  setLoading(true);
                  setPage(page - 1);
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-border hover:text-foreground hover:border-border-hover transition-all disabled:opacity-30 disabled:pointer-events-none"
              >
                {t("Previous")}
              </button>
              <span className="text-xs text-muted px-2">
                {page} / {pagination.totalPages}
              </span>
              <button
                disabled={page >= pagination.totalPages}
                onClick={() => {
                  setLoading(true);
                  setPage(page + 1);
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted border border-border hover:text-foreground hover:border-border-hover transition-all disabled:opacity-30 disabled:pointer-events-none"
              >
                {t("Next")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
