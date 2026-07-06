import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide39Tokens = contentTokens["slide-39"];

export function buildSlide39(presentation, tokens = slide39Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-39", width: "fill", height: "fill" }, [
      text([{ runs: [tokens.footer1] }], {
        name: "Google-Shape-532-p58",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15MiddleRightColorTx1,
      }),
      text([tokens.title], {
        name: "Google-Shape-533-p58",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "61px" }),
        style: textStyles.helveticaNeueFont39TopColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-8",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "42px", top: "187px", width: "581px", height: "103px" }),
      }),
      text([tokens.body3], {
        name: "Content-Placeholder-10",
        ...frame({ left: "73px", top: "215px", width: "524px", height: "54px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-15",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "42px", top: "306px", width: "581px", height: "116px" }),
      }),
      text([tokens.body5], {
        name: "Content-Placeholder-10",
        ...frame({ left: "73px", top: "331px", width: "524px", height: "73px" }),
        style: textStyles.helveticaNeueFont32ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.body9.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body9.detailGoesHere, tokens.body9.detailGoesHere2], {
        name: "Content-Placeholder-15",
        ...frame({ left: "73px", top: "530px", width: "550px", height: "129px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-1",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "42px", top: "439px", width: "581px", height: "64px" }),
      }),
      text([tokens.body8], {
        name: "Content-Placeholder-10",
        ...frame({ left: "73px", top: "461px", width: "524px", height: "23px" }),
        style: textStyles.helveticaNeueFont32ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.body1.topic, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "TextBox-4",
        ...frame({ left: "41px", top: "105px", width: "581px", height: "61px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-5",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "659px", top: "400px", width: "581px", height: "103px" }),
      }),
      text([tokens.body7], {
        name: "Content-Placeholder-10",
        ...frame({ left: "690px", top: "428px", width: "524px", height: "54px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-7",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "659px", top: "187px", width: "581px", height: "116px" }),
      }),
      text([tokens.body4], {
        name: "Content-Placeholder-10",
        ...frame({ left: "690px", top: "212px", width: "524px", height: "73px" }),
        style: textStyles.helveticaNeueFont32ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.body10.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body10.detailGoesHere, tokens.body10.detailGoesHere2], {
        name: "Content-Placeholder-15",
        ...frame({ left: "690px", top: "530px", width: "550px", height: "129px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-13",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "659px", top: "320px", width: "581px", height: "64px" }),
      }),
      text([tokens.body6], {
        name: "Content-Placeholder-10",
        ...frame({ left: "690px", top: "342px", width: "524px", height: "23px" }),
        style: textStyles.helveticaNeueFont32ResizeShapeToFitTextColorTx1,
      }),
      text([tokens.body2.topic, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "TextBox-24",
        ...frame({ left: "658px", top: "105px", width: "581px", height: "61px" }),
        style: textStyles.helveticaNeueFont24ResizeShapeToFitTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
