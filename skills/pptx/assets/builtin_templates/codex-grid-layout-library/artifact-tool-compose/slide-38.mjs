import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide38Tokens = contentTokens["slide-38"];

export function buildSlide38(presentation, tokens = slide38Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-38", width: "fill", height: "fill" }, [
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
        ...frame({ left: "42px", top: "111px", width: "581px", height: "103px" }),
      }),
      text([tokens.body1], {
        name: "Content-Placeholder-10",
        ...frame({ left: "73px", top: "138px", width: "524px", height: "54px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body3.detailGoesHere, tokens.body3.detailGoesHere2, tokens.body3.detailGoesHere3], {
        name: "Content-Placeholder-15",
        ...frame({ left: "73px", top: "230px", width: "550px", height: "155px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-15",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "42px", top: "399px", width: "581px", height: "103px" }),
      }),
      text([tokens.body5], {
        name: "Content-Placeholder-10",
        ...frame({ left: "73px", top: "426px", width: "524px", height: "54px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body7.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body7.detailGoesHere, tokens.body7.detailGoesHere2, tokens.body7.detailGoesHere3], {
        name: "Content-Placeholder-15",
        ...frame({ left: "73px", top: "518px", width: "550px", height: "155px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-18",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "657px", top: "111px", width: "581px", height: "103px" }),
      }),
      text([tokens.body2], {
        name: "Content-Placeholder-10",
        ...frame({ left: "688px", top: "138px", width: "524px", height: "54px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body4.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body4.detailGoesHere, tokens.body4.detailGoesHere2, tokens.body4.detailGoesHere3], {
        name: "Content-Placeholder-15",
        ...frame({ left: "688px", top: "230px", width: "550px", height: "155px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
      shape({
        name: "Rounded-Rectangle-21",
        geometry: "roundRect",
        fill: "bg2",
        ...frame({ left: "657px", top: "399px", width: "581px", height: "103px" }),
      }),
      text([tokens.body6], {
        name: "Content-Placeholder-10",
        ...frame({ left: "688px", top: "426px", width: "524px", height: "54px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body8.loremIpsumDolorSitAmetConsecteturAdipiscing, tokens.body8.detailGoesHere, tokens.body8.detailGoesHere2, tokens.body8.detailGoesHere3], {
        name: "Content-Placeholder-15",
        ...frame({ left: "688px", top: "518px", width: "550px", height: "155px" }),
        style: textStyles.helveticaNeueFont21ColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
