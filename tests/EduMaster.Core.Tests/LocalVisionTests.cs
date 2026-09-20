using System.Text.Json;
using EduMaster.Core;
namespace EduMaster.Core.Tests;

public class LocalVisionTests
{
    private static byte[] Response(string text,string finish)=>JsonSerializer.SerializeToUtf8Bytes(new{choices=new[]{new{finish_reason=finish,message=new{content=text}}}});
    [Fact] public void TruncatedRecognitionCannotBecomeProblem()=>Assert.Throws<InvalidDataException>(()=>LocalVisionReader.Parse(Response("반응식과 조건이 잘린 본문입니다","length")));
    [Fact] public void EmptyRecognitionCannotBecomeProblem()=>Assert.Throws<InvalidDataException>(()=>LocalVisionReader.Parse(Response("","stop")));
    [Fact] public void MalformedRecognitionIsExplained()=>Assert.Throws<InvalidDataException>(()=>LocalVisionReader.Parse("{}"u8.ToArray()));
    [Fact] public void MathFormattingPreservesPhysicalQuantity()=>Assert.Equal("(C의 몰질량)/(B의 몰질량) × 2",LocalVisionReader.NormalizeMath(@"$\frac{\text{C의 몰질량}}{\text{B의 몰질량}} \times 2$"));
    [Fact] public void QuantityWordsAreNeverRewritten()=>Assert.Equal("몰질량 물질량 질량",LocalVisionReader.NormalizeMath("몰질량 물질량 질량"));
}
