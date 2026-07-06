import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide70Tokens = contentTokens["slide-70"];

export function buildSlide70(presentation, tokens = slide70Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-70", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-3",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-7",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-4",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "213px", width: "375px", height: "416px" }),
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-8",
        ...frame({ left: "68px", top: "243px", width: "322px", height: "214px" }),
        style: textStyles.helveticaNeueFont32InsetsColorTx1,
      }),
      text([tokens.label1], {
        name: "Content-Placeholder-8",
        ...frame({ left: "68px", top: "502px", width: "322px", height: "22px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.stat1], {
        name: "Content-Placeholder-8",
        ...frame({ left: "68px", top: "555px", width: "179px", height: "51px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.label4], {
        name: "Content-Placeholder-8",
        ...frame({ left: "247px", top: "570px", width: "143px", height: "22px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-1",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "452px", top: "213px", width: "375px", height: "416px" }),
      }),
      text([tokens.body2.titleHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-8",
        ...frame({ left: "478px", top: "243px", width: "322px", height: "214px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.label2], {
        name: "Content-Placeholder-8",
        ...frame({ left: "478px", top: "502px", width: "322px", height: "22px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.stat2], {
        name: "Content-Placeholder-8",
        ...frame({ left: "478px", top: "555px", width: "179px", height: "51px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.label5], {
        name: "Content-Placeholder-8",
        ...frame({ left: "657px", top: "570px", width: "143px", height: "22px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-12",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "863px", top: "213px", width: "375px", height: "416px" }),
      }),
      text([tokens.body3.titleHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-8",
        ...frame({ left: "889px", top: "243px", width: "322px", height: "214px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.label3], {
        name: "Content-Placeholder-8",
        ...frame({ left: "889px", top: "502px", width: "322px", height: "22px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.stat3], {
        name: "Content-Placeholder-8",
        ...frame({ left: "889px", top: "555px", width: "179px", height: "51px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
      text([tokens.label6], {
        name: "Content-Placeholder-8",
        ...frame({ left: "1068px", top: "570px", width: "143px", height: "22px" }),
        style: textStyles.helveticaNeueFont32ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
