import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide61Tokens = contentTokens["slide-61"];

export function buildSlide61(presentation, tokens = slide61Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-61", width: "fill", height: "fill" }, [
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
      shape({
        name: "Rounded-Rectangle-2",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "213px", width: "271px", height: "416px" }),
      }),
      shape({
        name: "Rounded-Rectangle-4",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "350px", top: "213px", width: "273px", height: "416px" }),
      }),
      shape({
        name: "Rounded-Rectangle-5",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "657px", top: "213px", width: "271px", height: "416px" }),
      }),
      shape({
        name: "Rounded-Rectangle-6",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "966px", top: "213px", width: "273px", height: "416px" }),
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-15",
        ...frame({ left: "65px", top: "253px", width: "225px", height: "168px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Text-Placeholder-16",
        ...frame({ left: "373px", top: "253px", width: "226px", height: "168px" }),
        style: textStyles.helveticaNeueFont24ColorTx1,
      }),
      text([tokens.body3.titleHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-17",
        ...frame({ left: "681px", top: "253px", width: "225px", height: "168px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      text([tokens.body4.titleHere, tokens.body4.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Text-Placeholder-18",
        ...frame({ left: "990px", top: "253px", width: "226px", height: "168px" }),
        style: textStyles.helveticaNeueFont24ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
