using EduMaster.Core;
using EduMaster.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
namespace EduMaster.Core.Tests;
public class RendererCompatibilityTests
{
    private static SampleResult Fixture(double level)=>new(Guid.NewGuid(),Guid.NewGuid(),"fingerprint","비커","그림은 HCl 0.2 M 30 mL의 비커이다.",["1","2","3","4","5"],"② 2","해설",["1","2","3"],"변형"){Drawings=[new("실험",1000,500,"비커",[new("beaker",[150,120,200,220,level],"",26,false,"gray"),new("text",[150,400],"HCl 0.2 M 30 mL",26,false,"none")])]};
    [Theory][InlineData(0)][InlineData(.01)][InlineData(.55)][InlineData(1)]
    public void OldClientReceivesSupportedShapesAndKeepsProblemAndLabels(double level)
    {
        var original=Fixture(level);var old=RendererCompatibility.ForClient(original,"")!;Assert.Equal(original.Body,old.Body);Assert.Equal(original.Answer,old.Answer);Assert.DoesNotContain(old.Drawings[0].Elements,e=>e.Type=="beaker");Assert.Contains(old.Drawings[0].Elements,e=>e.Text=="HCl 0.2 M 30 mL");
        var json=JsonSerializer.Serialize(old.Drawings,new JsonSerializerOptions{PropertyNamingPolicy=JsonNamingPolicy.CamelCase});Assert.Single(ScientificVisuals.ParseDrawings(JsonNode.Parse(json)));
        Assert.Equal(level>0,old.Drawings[0].Elements.Any(e=>e.Type=="polygon"&&e.Fill=="gray"));Assert.Contains(old.Drawings[0].Elements,e=>e.Type=="ellipse");Assert.Contains(old.Drawings[0].Elements,e=>e.Type=="polyline"&&e.Coordinates.Length>20);
    }
    [Fact]public void CapableClientRetainsTypedData(){var original=Fixture(.55);Assert.Same(original,RendererCompatibility.ForClient(original,"beaker-v1"));Assert.Null(RendererCompatibility.ForClient(null,""));}
}
