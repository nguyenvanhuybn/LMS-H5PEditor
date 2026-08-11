"use client";

import { CheckCircleFilled, LoadingOutlined } from "@ant-design/icons";
import { Result, Spin } from "antd";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { apiFetch } from "@/lib/api";

function CallbackContent() {
  const params = useSearchParams();
  const { t } = useLocale();
  const [state, setState] = useState<"saving" | "done" | "error">("saving");

  useEffect(() => {
    const contentId = params.get("contentId");
    const title = params.get("title");
    if (!contentId) {
      setState("error");
      return;
    }

    apiFetch("/api/contents", {
      method: "POST",
      body: JSON.stringify({ h5pContentId: contentId, title }),
    })
      .then(() => {
        setState("done");
        window.parent.postMessage({ type: "h5p-content-saved", contentId }, window.location.origin);
        if (window.opener) {
          window.opener.postMessage({ type: "h5p-content-saved", contentId }, window.location.origin);
          window.close();
        }
      })
      .catch(() => setState("error"));
  }, [params]);

  if (state === "error") return <Result status="error" title={t("callback.errorTitle")} />;
  if (state === "done") return <Result icon={<CheckCircleFilled style={{ color: "#059669" }} />} title={t("callback.doneTitle")} subTitle={t("callback.doneSubtitle")} />;
  return <div className="callback-loading"><Spin indicator={<LoadingOutlined spin />} size="large" /><span>{t("callback.syncing")}</span></div>;
}

export default function ContentCallbackPage() {
  return <Suspense fallback={<Spin />}><CallbackContent /></Suspense>;
}
