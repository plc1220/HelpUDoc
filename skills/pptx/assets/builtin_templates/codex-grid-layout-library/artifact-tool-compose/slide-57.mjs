import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide57Tokens = contentTokens["slide-57"];

export function buildSlide57(presentation, tokens = slide57Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-57", width: "fill", height: "fill" }, [
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-15",
        ...frame({ left: "41px", top: "401px", width: "273px", height: "123px" }),
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
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Text-Placeholder-16",
        ...frame({ left: "453px", top: "401px", width: "273px", height: "123px" }),
        style: textStyles.helveticaNeueFont24ColorTx1,
      }),
      text([tokens.body3.titleHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-17",
        ...frame({ left: "865px", top: "401px", width: "273px", height: "123px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      shape({
        name: "Google-Shape-2259-p159",
        geometry: "straightConnector1",
        fill: "none",
        line: { style: "solid", width: 1, fill: "dk1" },
        ...frame({ left: "35px", top: "354px", width: "1286px", height: "1px" }),
      }),
      shape({
        name: "Google-Shape-2260-p159",
        geometry: "ellipse",
        fill: "dk1",
        ...frame({ left: "35px", top: "349px", width: "11px", height: "11px" }),
      }),
      shape({
        name: "Google-Shape-2261-p159",
        geometry: "ellipse",
        fill: "dk1",
        ...frame({ left: "446px", top: "349px", width: "11px", height: "11px" }),
      }),
      shape({
        name: "Google-Shape-2262-p159",
        geometry: "ellipse",
        fill: "dk1",
        ...frame({ left: "858px", top: "349px", width: "11px", height: "11px" }),
      }),
      text([tokens.label1], {
        name: "Content-Placeholder-15",
        ...frame({ left: "41px", top: "299px", width: "169px", height: "28px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      text([tokens.label2], {
        name: "Content-Placeholder-15",
        ...frame({ left: "451px", top: "299px", width: "169px", height: "28px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      text([tokens.label3], {
        name: "Content-Placeholder-15",
        ...frame({ left: "863px", top: "299px", width: "169px", height: "28px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
