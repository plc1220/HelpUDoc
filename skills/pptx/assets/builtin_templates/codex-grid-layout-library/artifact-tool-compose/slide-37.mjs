import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide37Tokens = contentTokens["slide-37"];

export function buildSlide37(presentation, tokens = slide37Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-37", width: "fill", height: "fill" }, [
      text([tokens.body1], {
        name: "Google-Shape-534-p58",
        ...frame({ left: "41px", top: "181px", width: "581px", height: "91px" }),
        style: textStyles.helveticaNeueFont32TopColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      text([tokens.label1], {
        name: "Content-Placeholder-10",
        ...frame({ left: "828px", top: "314px", width: "411px", height: "58px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "788px", top: "317px", width: "22px", height: "22px" }),
      }),
      text([tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing2], {
        name: "TextBox-11",
        ...frame({ left: "41px", top: "314px", width: "581px", height: "303px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.label2], {
        name: "Content-Placeholder-10",
        ...frame({ left: "828px", top: "378px", width: "411px", height: "58px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "788px", top: "381px", width: "22px", height: "22px" }),
      }),
      text([tokens.label3], {
        name: "Content-Placeholder-10",
        ...frame({ left: "828px", top: "443px", width: "411px", height: "58px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "788px", top: "445px", width: "22px", height: "22px" }),
      }),
      text([tokens.label4], {
        name: "Content-Placeholder-10",
        ...frame({ left: "828px", top: "506px", width: "411px", height: "58px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "788px", top: "509px", width: "22px", height: "22px" }),
      }),
      text([tokens.label5], {
        name: "Content-Placeholder-10",
        ...frame({ left: "828px", top: "572px", width: "411px", height: "58px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Google-Shape-340-p61",
        geometry: "rect",
        fill: "#000000",
        ...frame({ left: "788px", top: "574px", width: "22px", height: "22px" }),
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
