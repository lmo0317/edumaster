using EduMaster.Core;
namespace EduMaster.Web;
public static class RendererCompatibility
{
    public static SampleResult? ForClient(SampleResult? result,string capability)
    {
        if(result is null||capability=="beaker-v1")return result;
        return result with{Drawings=result.Drawings.Select(d=>d with{Elements=d.Elements.SelectMany(e=>e.Type=="beaker"?ExpandBeaker(e):new[]{e}).ToArray()}).ToArray()};
    }
    private static IEnumerable<DrawingElement> ExpandBeaker(DrawingElement e)
    {
        var p=e.Coordinates;var x=p[0];var y=p[1];var w=p[2];var h=p[3];var level=p[4];
        var left=x+w*.11;var right=x+w*.86;var top=y+h*.09;var bottom=y+h*.95;var rx=w*.375;var ry=h*.045;var cx=(left+right)/2;var radius=w*.10;
        DrawingElement Shape(string type,double[] coordinates,string fill="none")=>new(type,coordinates,"",26,false,fill);
        var outline=new List<double>{left,top,left+w*.025,bottom-radius};
        void Curve(double sx,double sy,double qx,double qy,double ex,double ey){for(var i=1;i<=10;i++){var t=i/10d;var a=1-t;outline.Add(a*a*sx+2*a*t*qx+t*t*ex);outline.Add(a*a*sy+2*a*t*qy+t*t*ey);}}
        Curve(left+w*.025,bottom-radius,left+w*.025,bottom,left+radius,bottom);
        outline.AddRange(new[]{right-radius,bottom});Curve(right-radius,bottom,right-w*.025,bottom,right-w*.025,bottom-radius);outline.AddRange(new[]{right,top});
        if(level>0&&e.Fill!="none"){
            var surface=bottom-level*(bottom-top-h*.07);
            // Intersect the actual curved vessel contour so low liquid levels cannot escape the glass.
            var contour=new List<(double X,double Y)>();for(var i=0;i<outline.Count;i+=2)contour.Add((outline[i],outline[i+1]));
            var clipped=new List<double>();var previous=contour[^1];
            foreach(var current in contour){var a=previous.Y>=surface;var b=current.Y>=surface;if(a!=b){var t=(surface-previous.Y)/(current.Y-previous.Y);clipped.Add(previous.X+t*(current.X-previous.X));clipped.Add(surface);}if(b){clipped.Add(current.X);clipped.Add(current.Y);}previous=current;}
            yield return Shape("polygon",clipped.ToArray(),"gray");
            var surfaceXs=new List<double>();previous=contour[^1];foreach(var current in contour){if((previous.Y>=surface)!=(current.Y>=surface)){var t=(surface-previous.Y)/(current.Y-previous.Y);surfaceXs.Add(previous.X+t*(current.X-previous.X));}previous=current;}
            if(surfaceXs.Count>=2){var liquidRx=(surfaceXs.Max()-surfaceXs.Min())/2;var liquidRy=Math.Min(ry*.8,(bottom-surface)*.45);yield return Shape("ellipse",new[]{cx,surface,liquidRx,liquidRy},"gray");}
        }
        yield return Shape("polyline",outline.ToArray());
        yield return Shape("ellipse",new[]{cx,top,rx,ry});
        yield return Shape("polyline",new[]{right-w*.015,top+ry*.35,x+w*.98,top-ry*.65,right-w*.015,top-ry*.35});
        for(var i=0;i<5;i++){var ty=top+h*.20+i*h*.11;yield return Shape("line",new[]{right-w*.15,ty,right-w*(i%2==0?.31:.24),ty});}
    }
}
