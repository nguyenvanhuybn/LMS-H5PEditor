"use client";

import { useParams } from "next/navigation";
import { H5pEditorFrame } from "@/components/H5pEditorFrame";

export default function EditContentPage() {
  const params = useParams<{ id: string }>();
  return <H5pEditorFrame contentId={params.id} />;
}
