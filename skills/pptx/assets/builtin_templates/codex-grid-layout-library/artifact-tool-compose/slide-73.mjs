import { image, layers, shape, table, text } from "@oai/artifact-tool";
import { contentTokens, frame, textStyles } from "./runtime.mjs";

export const slide73Tokens = contentTokens["slide-73"];

export function buildSlide73(presentation, tokens = slide73Tokens) {
  const slide = presentation.slides.add();
  slide.background.fill = "#FFFFFF";
  slide.compose(
    layers({ name: "codex-grid-layout-library#slide-73", width: "fill", height: "fill" }, [
      text([tokens.body1.titleGoesHere, tokens.body1.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-9",
        ...frame({ left: "41px", top: "213px", width: "375px", height: "208px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([{ runs: [tokens.footer1] }], {
        name: "Slide-Number-Placeholder-1",
        ...frame({ left: "1184px", top: "659px", width: "54px", height: "25px" }),
        style: textStyles.helveticaNeueFont15BottomRightColorTx1,
      }),
      text([tokens.body2.titleGoesHere, tokens.body2.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-10",
        ...frame({ left: "453px", top: "213px", width: "375px", height: "208px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body3.titleGoesHere, tokens.body3.loremIpsumDolorSitAmetConsecteturAdipiscing], {
        name: "Content-Placeholder-11",
        ...frame({ left: "864px", top: "213px", width: "375px", height: "208px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.title], {
        name: "Title-2",
        ...frame({ left: "41px", top: "36px", width: "1197px", height: "110px" }),
        style: textStyles.helveticaNeueFont39TopShrinkTextColorTx1,
      }),
      text([tokens.body4.detailGoesHere, tokens.body4.detailGoesHere2, tokens.body4.detailGoesHere3, tokens.body4.detailGoesHere4], {
        name: "Content-Placeholder-9",
        ...frame({ left: "41px", top: "434px", width: "375px", height: "195px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body5.detailGoesHere, tokens.body5.detailGoesHere2, tokens.body5.detailGoesHere3, tokens.body5.detailGoesHere4], {
        name: "Content-Placeholder-9",
        ...frame({ left: "452px", top: "434px", width: "375px", height: "195px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
      text([tokens.body6.detailGoesHere, tokens.body6.detailGoesHere2, tokens.body6.detailGoesHere3, tokens.body6.detailGoesHere4], {
        name: "Content-Placeholder-9",
        ...frame({ left: "864px", top: "434px", width: "375px", height: "195px" }),
        style: textStyles.helveticaNeueFont32ShrinkTextColorTx1,
      }),
    ]),
    { frame: { left: 0, top: 0, width: 1280, height: 720 }, baseUnit: 1 },
  );
  return slide;
}
