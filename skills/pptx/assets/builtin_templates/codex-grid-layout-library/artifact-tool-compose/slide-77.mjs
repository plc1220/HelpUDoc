import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide77Tokens = contentTokens["slide-77"];

export function buildSlide77(presentation, tokens = slide77Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-77", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer2] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "786px", height: "72px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-5",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "457px", width: "245px", height: "198px" }),
      }),
      shape({
        name: "Rounded-Rectangle-18",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "312px", top: "457px", width: "245px", height: "198px" }),
      }),
      shape({
        name: "Rounded-Rectangle-19",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "582px", top: "457px", width: "245px", height: "198px" }),
      }),
      text([tokens.footer1], {
        name: "Footer-Placeholder-24",
        ...frame({ left: "41px", top: "659px", width: "375px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomColorTx1,
      }),
      text([tokens.body1.titleHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing2, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing3], {
        name: "Content-Placeholder-2",
        ...frame({ left: "864px", top: "249px", width: "375px", height: "406px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.stat4], {
        name: "Content-Placeholder-9",
        ...frame({ left: "59px", top: "479px", width: "169px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.label4], {
        name: "Content-Placeholder-9",
        ...frame({ left: "69px", top: "574px", width: "169px", height: "41px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.stat5], {
        name: "Content-Placeholder-9",
        ...frame({ left: "333px", top: "479px", width: "169px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.label5], {
        name: "Content-Placeholder-9",
        ...frame({ left: "343px", top: "574px", width: "169px", height: "41px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.stat6], {
        name: "Content-Placeholder-9",
        ...frame({ left: "606px", top: "479px", width: "169px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.label6], {
        name: "Content-Placeholder-9",
        ...frame({ left: "616px", top: "574px", width: "169px", height: "41px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-3",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "41px", top: "235px", width: "245px", height: "198px" }),
      }),
      shape({
        name: "Rounded-Rectangle-4",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "312px", top: "235px", width: "245px", height: "198px" }),
      }),
      shape({
        name: "Rounded-Rectangle-6",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "582px", top: "235px", width: "245px", height: "198px" }),
      }),
      text([tokens.stat1], {
        name: "Content-Placeholder-9",
        ...frame({ left: "59px", top: "257px", width: "169px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.label1], {
        name: "Content-Placeholder-9",
        ...frame({ left: "69px", top: "352px", width: "169px", height: "41px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.stat2], {
        name: "Content-Placeholder-9",
        ...frame({ left: "333px", top: "257px", width: "169px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.label2], {
        name: "Content-Placeholder-9",
        ...frame({ left: "343px", top: "352px", width: "169px", height: "41px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.stat3], {
        name: "Content-Placeholder-9",
        ...frame({ left: "606px", top: "257px", width: "169px", height: "95px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
      text([tokens.label3], {
        name: "Content-Placeholder-9",
        ...frame({ left: "616px", top: "352px", width: "169px", height: "41px" }),
        style: textStyles.helveticaNeueFont32BottomShrinkTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
