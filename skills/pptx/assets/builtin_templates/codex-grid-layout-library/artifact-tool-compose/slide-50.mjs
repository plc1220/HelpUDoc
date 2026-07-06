import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide50Tokens = contentTokens["slide-50"];

export function buildSlide50(presentation, tokens = slide50Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-50", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "375px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.body2], {
        name: "Content-Placeholder-10",
        ...frame({ left: "732px", top: "249px", width: "507px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label1], {
        name: "Content-Placeholder-10",
        ...frame({ left: "509px", top: "249px", width: "196px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body3], {
        name: "Content-Placeholder-10",
        ...frame({ left: "732px", top: "353px", width: "507px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label2], {
        name: "Content-Placeholder-10",
        ...frame({ left: "509px", top: "353px", width: "196px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body4], {
        name: "Content-Placeholder-10",
        ...frame({ left: "732px", top: "457px", width: "507px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label3], {
        name: "Content-Placeholder-10",
        ...frame({ left: "509px", top: "457px", width: "196px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body5], {
        name: "Content-Placeholder-10",
        ...frame({ left: "732px", top: "563px", width: "507px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.label4], {
        name: "Content-Placeholder-10",
        ...frame({ left: "509px", top: "563px", width: "196px", height: "68px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body1.quamUtMassaLuctusCursusNullamPharetra], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "249px", width: "375px", height: "380px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "471px", top: "252px", width: "20px", height: "20px" }),
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "471px", top: "357px", width: "20px", height: "20px" }),
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "471px", top: "460px", width: "20px", height: "20px" }),
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "471px", top: "566px", width: "20px", height: "20px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
