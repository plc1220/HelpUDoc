import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide32Tokens = contentTokens["slide-32"];

export function buildSlide32(presentation, tokens = slide32Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-32", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "165px", width: "1197px", height: "189px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "Freeform-10",
        geometry: "rect",
        fill: "bg1",
        ...frame({ left: "95px", top: "429px", width: "189px", height: "35px" }),
      }),
      shape({
        name: "Freeform-11",
        geometry: "rect",
        fill: "bg1",
        ...frame({ left: "393px", top: "429px", width: "189px", height: "35px" }),
      }),
      shape({
        name: "Freeform-12",
        geometry: "rect",
        fill: "bg1",
        ...frame({ left: "692px", top: "429px", width: "189px", height: "35px" }),
      }),
      shape({
        name: "Freeform-13",
        geometry: "rect",
        fill: "bg1",
        ...frame({ left: "991px", top: "429px", width: "189px", height: "35px" }),
      }),
      shape({
        name: "Freeform-14",
        geometry: "rect",
        fill: "bg1",
        ...frame({ left: "95px", top: "536px", width: "189px", height: "35px" }),
      }),
      shape({
        name: "Freeform-15",
        geometry: "rect",
        fill: "bg1",
        ...frame({ left: "393px", top: "536px", width: "189px", height: "35px" }),
      }),
      shape({
        name: "Freeform-16",
        geometry: "rect",
        fill: "bg1",
        ...frame({ left: "692px", top: "536px", width: "189px", height: "35px" }),
      }),
      shape({
        name: "Freeform-17",
        geometry: "rect",
        fill: "bg1",
        ...frame({ left: "991px", top: "536px", width: "189px", height: "35px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
