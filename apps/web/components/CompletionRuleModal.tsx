"use client";

import { Alert, App, Modal, Space } from "antd";
import { useEffect, useState } from "react";
import {
  CompletionRuleFields,
  draftFromContent,
  type CompletionDraft,
} from "@/components/CompletionRuleFields";
import { useLocale } from "@/components/LocaleProvider";
import { saveCompletionRule, type ContentItem } from "@/lib/api";

export function CompletionRuleModal({
  content,
  open,
  onClose,
  onSaved,
}: {
  content?: ContentItem;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const { message } = App.useApp();
  const [draft, setDraft] = useState<CompletionDraft>(draftFromContent());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !content) return;
    setDraft(draftFromContent(content));
  }, [open, content]);

  const save = async () => {
    if (!content) return;
    setSaving(true);
    try {
      await saveCompletionRule(content.h5pContentId, draft);
      message.success(t("completion.saved"));
      onSaved();
      onClose();
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : t("completion.failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void save()}
      confirmLoading={saving}
      okText={t("completion.save")}
      cancelText={t("completion.cancel")}
      title={t("completion.title", { title: content?.title ?? "" })}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <CompletionRuleFields content={content} value={draft} onChange={setDraft} />
        <Alert type="info" showIcon message={t("completion.exportNote")} />
      </Space>
    </Modal>
  );
}
