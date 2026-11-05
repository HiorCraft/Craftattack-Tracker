"use client";

import { useEffect } from "react";

/** Scrollt nach dem Laden zum hervorgehobenen Element (die Seite wird gestreamt, der Anker allein reicht nicht). */
export function ScrollToHighlight({ id }: { id: string }) {
  useEffect(() => {
    document.getElementById(id)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [id]);
  return null;
}
