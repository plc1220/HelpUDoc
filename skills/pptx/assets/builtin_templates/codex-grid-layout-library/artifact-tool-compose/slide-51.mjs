import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide51Tokens = contentTokens["slide-51"];

export function buildSlide51(presentation, tokens = slide51Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-51", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "583px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.label1], {
        name: "Content-Placeholder-10",
        ...frame({ left: "658px", top: "38px", width: "578px", height: "71px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "594px", top: "43px", width: "27px", height: "27px" }),
      }),
      text([tokens.label2], {
        name: "Content-Placeholder-10",
        ...frame({ left: "658px", top: "143px", width: "578px", height: "71px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "594px", top: "147px", width: "27px", height: "27px" }),
      }),
      text([tokens.label3], {
        name: "Content-Placeholder-10",
        ...frame({ left: "658px", top: "247px", width: "578px", height: "71px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "594px", top: "251px", width: "27px", height: "27px" }),
      }),
      text([tokens.label4], {
        name: "Content-Placeholder-10",
        ...frame({ left: "658px", top: "352px", width: "578px", height: "71px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "594px", top: "355px", width: "27px", height: "27px" }),
      }),
      text([tokens.label5], {
        name: "Content-Placeholder-10",
        ...frame({ left: "658px", top: "456px", width: "578px", height: "71px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "594px", top: "459px", width: "27px", height: "27px" }),
      }),
      text([tokens.label6], {
        name: "Content-Placeholder-10",
        ...frame({ left: "658px", top: "560px", width: "578px", height: "71px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "594px", top: "563px", width: "27px", height: "27px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
