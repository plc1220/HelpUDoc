import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide59Tokens = contentTokens["slide-59"];

export function buildSlide59(presentation, tokens = slide59Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-59", width: "fill", height: "fill" }, [
      shape({
        name: "Rounded-Rectangle-18",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "864px", top: "317px", width: "271px", height: "312px" }),
      }),
      text([tokens.body3.titleHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-15",
        ...frame({ left: "888px", top: "349px", width: "225px", height: "176px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      text([tokens.label3], {
        name: "Text-Placeholder-16",
        ...frame({ left: "891px", top: "582px", width: "177px", height: "22px" }),
        style: textStyles.helveticaNeueFont24ColorTx1,
      }),
      shape({
        name: "Google-Shape-2261-p159",
        geometry: "ellipse",
        fill: "dk1",
        ...frame({ left: "888px", top: "555px", width: "11px", height: "11px" }),
      }),
      shape({
        name: "Rounded-Rectangle-11",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "451px", top: "317px", width: "271px", height: "312px" }),
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-15",
        ...frame({ left: "474px", top: "349px", width: "225px", height: "176px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-6",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "317px", width: "271px", height: "312px" }),
      }),
      text([tokens.label1], {
        name: "Content-Placeholder-15",
        ...frame({ left: "65px", top: "583px", width: "182px", height: "20px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-3",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-10",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.label2], {
        name: "Text-Placeholder-16",
        ...frame({ left: "477px", top: "582px", width: "177px", height: "22px" }),
        style: textStyles.helveticaNeueFont24ColorTx1,
      }),
      shape({
        name: "Google-Shape-2259-p159",
        geometry: "straightConnector1",
        fill: "none",
        line: { style: "solid", width: 1, fill: "dk1" },
        ...frame({ left: "65px", top: "561px", width: "1286px", height: "1px" }),
      }),
      shape({
        name: "Google-Shape-2260-p159",
        geometry: "ellipse",
        fill: "dk1",
        ...frame({ left: "65px", top: "555px", width: "11px", height: "11px" }),
      }),
      shape({
        name: "Google-Shape-2261-p159",
        geometry: "ellipse",
        fill: "dk1",
        ...frame({ left: "475px", top: "555px", width: "11px", height: "11px" }),
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-15",
        ...frame({ left: "65px", top: "349px", width: "225px", height: "176px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
