"use client";

import { Form, InputNumber, Radio, Slider, Space, Typography } from "antd";
import { useLocale } from "@/components/LocaleProvider";
import { compactLibraryName, type ContentItem } from "@/lib/api";

export type CompletionMode = "Default" | "Score" | "Position";

export type CompletionDraft = {
  mode: CompletionMode;
  passPercent: number;
  minPosition: number;
};

/**
 * Content types whose statements carry the ending-point position extension —
 * verified against the installed libraries' source, not the docs. Summary is
 * deliberately absent: it emits "progressed" but never a position, so a
 * position rule on it would simply never fire. Interactive Book and
 * Interactive Video report no usable position either.
 */
const POSITION_CAPABLE = [
  "H5P.CoursePresentation",
  "H5P.QuestionSet",
  "H5P.BranchingScenario",
  "H5P.Column",
  "H5P.DocumentationTool",
  "H5P.GameMap",
  "H5P.Questionnaire",
  "H5P.SpeakTheWordsSet",
];

export function draftFromContent(content?: ContentItem): CompletionDraft {
  return {
    mode: (content?.completionMode ?? "Default") as CompletionMode,
    passPercent: Math.round((content?.passRatio ?? 0.5) * 100),
    minPosition: content?.minPosition ?? 1,
  };
}

export function supportsPosition(content?: ContentItem) {
  return content?.mainLibrary
    ? POSITION_CAPABLE.some((name) => content.mainLibrary!.startsWith(name))
    : false;
}

/**
 * The completion rule editor, shared by the standalone dialog and the export
 * dialog. The rule is compiled into every package, so the export screen has to
 * offer it rather than send the operator elsewhere first.
 */
export function CompletionRuleFields({
  content,
  value,
  onChange,
}: {
  content?: ContentItem;
  value: CompletionDraft;
  onChange: (next: CompletionDraft) => void;
}) {
  const { t } = useLocale();
  const positionAvailable = supportsPosition(content);

  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <Radio.Group
        value={value.mode}
        onChange={(event) => onChange({ ...value, mode: event.target.value })}
      >
        <Space direction="vertical" size={6}>
          <Radio value="Default">
            {t("completion.modeDefault")}
            <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
              {t("completion.modeDefaultHint")}
            </Typography.Text>
          </Radio>
          <Radio value="Score">
            {t("completion.modeScore")}
            <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
              {t("completion.modeScoreHint")}
            </Typography.Text>
          </Radio>
          <Radio value="Position" disabled={!positionAvailable}>
            {t("completion.modePosition")}
            <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
              {positionAvailable
                ? t("completion.modePositionHint")
                : t("completion.modePositionUnsupported", { library: compactLibraryName(content?.mainLibrary) })}
            </Typography.Text>
          </Radio>
        </Space>
      </Radio.Group>

      {value.mode === "Score" && (
        <Form layout="vertical">
          <Form.Item
            label={t("completion.passLabel", { percent: value.passPercent })}
            style={{ marginBottom: 0 }}
          >
            <Slider
              min={0}
              max={100}
              step={5}
              value={value.passPercent}
              onChange={(passPercent) => onChange({ ...value, passPercent })}
            />
          </Form.Item>
        </Form>
      )}

      {value.mode === "Position" && (
        <Form layout="vertical">
          <Form.Item label={t("completion.positionLabel")} style={{ marginBottom: 0 }}>
            <InputNumber
              min={1}
              value={value.minPosition}
              onChange={(minPosition) => onChange({ ...value, minPosition: minPosition ?? 1 })}
            />
          </Form.Item>
        </Form>
      )}
    </Space>
  );
}
