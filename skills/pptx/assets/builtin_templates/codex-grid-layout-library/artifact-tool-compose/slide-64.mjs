import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide64Tokens = contentTokens["slide-64"];

export function buildSlide64(presentation, tokens = slide64Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-64", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-3",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-10",
        ...frame({ left: "41px", top: "36px", width: "581px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.stat1], {
        name: "Content-Placeholder-9",
        ...frame({ left: "679px", top: "428px", width: "224px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.body2], {
        name: "Content-Placeholder-15",
        ...frame({ left: "686px", top: "532px", width: "217px", height: "65px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.stat2], {
        name: "Content-Placeholder-9",
        ...frame({ left: "989px", top: "428px", width: "224px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.body3], {
        name: "Content-Placeholder-15",
        ...frame({ left: "996px", top: "532px", width: "217px", height: "65px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-1",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "109px", width: "580px", height: "571px" }),
      }),
      shape({
        name: "Rectangle-2",
        geometry: "rect",
        fill: "bg2",
        ...frame({ left: "657px", top: "457px", width: "7px", height: "121px" }),
      }),
      shape({
        name: "Rectangle-4",
        geometry: "rect",
        fill: "bg2",
        ...frame({ left: "967px", top: "457px", width: "7px", height: "121px" }),
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-1",
        ...frame({ left: "657px", top: "179px", width: "556px", height: "169px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Chart-6",
        geometry: "rect",
        fill: "#F7F7F7",
        line: { style: "dashed", width: 1, fill: "#B8BCC4" },
        ...frame({ left: "67px", top: "132px", width: "538px", height: "528px" }),
      }),
      text([{ runs: ["Chart placeholder: line"] }], {
        name: "Chart-6",
        ...frame({ left: "67px", top: "377px", width: "538px", height: "36px" }),
        style: { fontSize: "14px", color: "#6B7280", alignment: "center" },
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
