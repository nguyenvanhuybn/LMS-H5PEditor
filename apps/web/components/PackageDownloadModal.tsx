"use client";

import { DownloadOutlined } from "@ant-design/icons";
import { Alert, App, Button, Checkbox, Modal, Radio, Select, Space, Spin, Typography } from "antd";
import { useCallback, useEffect, useState } from "react";
import {
  CompletionRuleFields,
  draftFromContent,
  type CompletionDraft,
} from "@/components/CompletionRuleFields";
import { useLocale } from "@/components/LocaleProvider";
import { saveCompletionRule, type ContentItem } from "@/lib/api";
import type { TranslationKey } from "@/lib/i18n";

type Format = "scorm12" | "scorm2004" | "xapi";

const FORMATS: { value: Format; label: TranslationKey; hint: TranslationKey }[] = [
  { value: "scorm12", label: "package.scorm12", hint: "package.scorm12Hint" },
  { value: "scorm2004", label: "package.scorm2004", hint: "package.scorm2004Hint" },
  { value: "xapi", label: "package.xapi", hint: "package.xapiHint" },
];

export function PackageDownloadModal({
  content,
  open,
  onClose,
  onSaved,
}: {
  content?: ContentItem;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { t } = useLocale();
  const { message } = App.useApp();
  const [format, setFormat] = useState<Format>("scorm12");
  const [origins, setOrigins] = useState<{ origin: string; engineAccepts: boolean }[]>();
  const [engineOrigins, setEngineOrigins] = useState<string[]>();
  const [origin, setOrigin] = useState<string>();
  const [relayResults, setRelayResults] = useState(false);
  const [completion, setCompletion] = useState<CompletionDraft>(draftFromContent());
  const [loadError, setLoadError] = useState<string>();
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!open) return;

    setLoadError(undefined);
    setOrigins(undefined);
    setCompletion(draftFromContent(content));

    fetch("/api/packages/origins", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
        return body as { origins: { origin: string; engineAccepts: boolean }[]; engineOrigins?: string[] };
      })
      .then((body) => {
        setOrigins(body.origins);
        setEngineOrigins(body.engineOrigins ?? undefined);
        // Preselect one that actually works, so the common path needs no thought.
        const usable = body.origins.find((entry) => entry.engineAccepts) ?? body.origins[0];
        setOrigin((current) => current ?? usable?.origin);
      })
      .catch((reason) => setLoadError(reason instanceof Error ? reason.message : String(reason)));
  }, [open, content]);

  const download = useCallback(async () => {
    // Under a wildcard config the package adapts to its runtime origin, so
    // there is no specific origin to send.
    const wildcard = origins?.some((entry) => entry.origin === "*" && entry.engineAccepts) ?? false;
    const targetOrigin = wildcard ? "*" : origin;
    if (!content || !targetOrigin) return;

    setDownloading(true);
    try {
      // Save first: the rule is compiled into the package, so a package built
      // before the rule is stored would carry the previous one.
      await saveCompletionRule(content.h5pContentId, completion);
      onSaved?.();

      const query = new URLSearchParams({
        format,
        lmsOrigin: targetOrigin,
        relayResults: String(relayResults),
      });
      const response = await fetch(
        `/api/packages/${encodeURIComponent(content.h5pContentId)}?${query}`,
        { cache: "no-store" },
      );

      if (!response.ok) {
        // The API answers with JSON; showing the raw body would put braces and
        // escapes in front of the operator instead of the actual reason.
        const detail = await response.text();
        let reason = detail || `HTTP ${response.status}`;
        try {
          reason = JSON.parse(detail)?.error ?? reason;
        } catch {
          // Not JSON; the raw text is the best we have.
        }
        throw new Error(reason);
      }

      // Read the whole zip first so a mid-stream failure surfaces as an error
      // rather than a truncated file landing in the user's Downloads folder.
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const suggested = /filename="?([^";]+)"?/.exec(disposition)?.[1];

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = suggested ?? `h5p-${content.h5pContentId}-${format}.zip`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      message.success(t("package.done"));
      onClose();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : t("package.failed"));
    } finally {
      setDownloading(false);
    }
  }, [content, origins, origin, format, relayResults, completion, message, onClose, onSaved, t]);

  const noOrigins = origins?.length === 0;
  // With a "*" entry accepted end to end there is nothing to pick: the package
  // adapts to whatever origin it runs on, so the selector disappears.
  const allowAll = origins?.some((entry) => entry.origin === "*" && entry.engineAccepts) ?? false;
  const selected = origins?.find((entry) => entry.origin === origin);
  // Building a package the engine will not talk to only produces a silent
  // failure later, so stop it here.
  const canDownload = !loadError && (allowAll || (Boolean(origin) && selected?.engineAccepts !== false));

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={t("package.title", { title: content?.title ?? "" })}
      footer={[
        <Button key="cancel" onClick={onClose}>{t("package.cancel")}</Button>,
        <Button
          key="download"
          type="primary"
          icon={<DownloadOutlined />}
          loading={downloading}
          disabled={!canDownload}
          onClick={() => void download()}
        >
          {t("package.download")}
        </Button>,
      ]}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>{t("package.formatLabel")}</Typography.Text>
          <Radio.Group
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            style={{ display: "block", marginTop: 8 }}
          >
            <Space direction="vertical" size={6}>
              {FORMATS.map((item) => (
                <Radio key={item.value} value={item.value}>
                  {t(item.label)}
                  <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                    {t(item.hint)}
                  </Typography.Text>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </div>

        <div>
          <Typography.Text strong>{t("package.completionLabel")}</Typography.Text>
          <Typography.Text type="secondary" style={{ display: "block", fontSize: 12, marginBottom: 8 }}>
            {t("package.completionHint")}
          </Typography.Text>
          <CompletionRuleFields content={content} value={completion} onChange={setCompletion} />
        </div>

        <div>
          <Typography.Text strong>{t("package.originLabel")}</Typography.Text>
          {!allowAll && (
            <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
              {t("package.originHint")}
            </Typography.Text>
          )}
          {loadError ? (
            <Alert type="error" showIcon style={{ marginTop: 8 }} message={loadError} />
          ) : origins === undefined ? (
            <div style={{ marginTop: 8 }}><Spin size="small" /></div>
          ) : allowAll ? (
            <Alert type="success" showIcon style={{ marginTop: 8 }} message={t("package.originAny")} />
          ) : noOrigins ? (
            <Alert type="warning" showIcon style={{ marginTop: 8 }} message={t("package.noOrigins")} />
          ) : (
            <>
              <Select
                value={origin}
                onChange={setOrigin}
                style={{ width: "100%", marginTop: 8 }}
                options={origins.map((entry) => ({
                  value: entry.origin,
                  label: entry.engineAccepts ? entry.origin : `${entry.origin} — ${t("package.originRejected")}`,
                }))}
              />
              {selected && !selected.engineAccepts && (
                <Alert
                  type="error"
                  showIcon
                  style={{ marginTop: 8 }}
                  message={t("package.originRejectedDetail", {
                    origin: selected.origin,
                    accepted: engineOrigins?.join(", ") ?? "-",
                  })}
                />
              )}
            </>
          )}
        </div>

        <div>
          <Checkbox checked={relayResults} onChange={(event) => setRelayResults(event.target.checked)}>
            {t("package.relayLabel")}
          </Checkbox>
          <Typography.Text type="secondary" style={{ display: "block", fontSize: 12, marginLeft: 24 }}>
            {t("package.relayHint")}
          </Typography.Text>
        </div>

        {!allowAll && <Alert type="info" showIcon message={t("package.hostNote")} />}
      </Space>
    </Modal>
  );
}
